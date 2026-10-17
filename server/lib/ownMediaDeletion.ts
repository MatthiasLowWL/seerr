import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { NextFunction, Request, Response } from 'express';
import { EntityNotFoundError } from 'typeorm';

/**
 * Fork feature: let a user remove media (and its files in Radarr/Sonarr)
 * when every request on that title belongs to them.
 *
 * Kept in its own module so the upstream media routes only gain one line.
 */

class OwnMediaDeletionError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const ACTIVE_STATUSES = [
  MediaStatus.PENDING,
  MediaStatus.PROCESSING,
  MediaStatus.PARTIALLY_AVAILABLE,
  MediaStatus.AVAILABLE,
];

const removeFromService = async (media: Media, is4k: boolean) => {
  const settings = getSettings();
  const isMovie = media.mediaType === MediaType.MOVIE;
  const arrName = `${is4k ? '4K ' : ''}${isMovie ? 'Radarr' : 'Sonarr'}`;

  let serviceSettings;
  if (isMovie) {
    serviceSettings = settings.radarr.find(
      (radarr) => radarr.isDefault && radarr.is4k === is4k
    );
  } else {
    serviceSettings = settings.sonarr.find(
      (sonarr) => sonarr.isDefault && sonarr.is4k === is4k
    );
  }

  // Prefer the server this title was actually sent to. Server ids start at 0,
  // so check for null/undefined explicitly rather than truthiness.
  const specificServiceId = is4k ? media.serviceId4k : media.serviceId;
  if (
    specificServiceId !== null &&
    specificServiceId !== undefined &&
    specificServiceId >= 0 &&
    serviceSettings?.id !== specificServiceId
  ) {
    if (isMovie) {
      serviceSettings =
        settings.radarr.find((radarr) => radarr.id === specificServiceId) ??
        serviceSettings;
    } else {
      serviceSettings =
        settings.sonarr.find((sonarr) => sonarr.id === specificServiceId) ??
        serviceSettings;
    }
  }

  // No default and no recorded server: if exactly one server of this kind and
  // quality exists there is no ambiguity, so use it.
  if (!serviceSettings) {
    const candidates = (isMovie ? settings.radarr : settings.sonarr).filter(
      (server) => server.is4k === is4k
    );
    if (candidates.length === 1) {
      serviceSettings = candidates[0];
    }
  }

  if (!serviceSettings) {
    throw new OwnMediaDeletionError(
      409,
      `No ${arrName} server is configured, so the files cannot be removed.`
    );
  }

  if (isMovie) {
    const radarr = new RadarrAPI({
      apiKey: serviceSettings.apiKey,
      url: RadarrAPI.buildUrl(serviceSettings, '/api/v3'),
    });
    await radarr.removeMovie(media.tmdbId);
  } else {
    const sonarr = new SonarrAPI({
      apiKey: serviceSettings.apiKey,
      url: SonarrAPI.buildUrl(serviceSettings, '/api/v3'),
    });
    const tmdb = new TheMovieDb();
    const series = await tmdb.getTvShow({ tvId: media.tmdbId });
    const tvdbId = series.external_ids.tvdb_id ?? media.tvdbId;
    if (!tvdbId) {
      throw new OwnMediaDeletionError(
        500,
        'TVDB ID not found, so the series cannot be matched in Sonarr.'
      );
    }
    await sonarr.removeSeries(tvdbId);
  }
};

export const deleteOwnMedia = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const user = req.user;
  if (!user) {
    return next({ status: 401, message: 'You must be signed in.' });
  }

  const settings = getSettings();
  const isManager = user.hasPermission(Permission.MANAGE_REQUESTS);

  if (!isManager && !settings.main.allowOwnMediaDeletion) {
    return next({
      status: 403,
      message: 'Removing your own requested media is disabled.',
    });
  }

  const mediaRepository = getRepository(Media);
  const requestRepository = getRepository(MediaRequest);
  const mediaId = Number(req.params.id);

  try {
    const media = await mediaRepository.findOneOrFail({
      where: { id: mediaId },
      relations: { requests: true },
    });
    const requests = media.requests ?? [];

    if (!isManager) {
      if (requests.length === 0) {
        throw new OwnMediaDeletionError(
          403,
          'This title was not requested through Seerr, so it cannot be removed here.'
        );
      }
      if (requests.some((r) => r.requestedBy?.id !== user.id)) {
        throw new OwnMediaDeletionError(
          403,
          'Other users have also requested this title. Ask an administrator to remove it.'
        );
      }
    }

    const qualities = [false, true].filter((is4k) => {
      const status = is4k ? media.status4k : media.status;
      return (
        ACTIVE_STATUSES.includes(status) ||
        requests.some((r) => r.is4k === is4k)
      );
    });

    for (const is4k of qualities) {
      await removeFromService(media, is4k);
    }

    // Remove the requests first: the MediaRequest subscriber recomputes the
    // parent status on removal, and we overwrite it with DELETED below.
    if (requests.length > 0) {
      await requestRepository.remove(requests);
    }

    // Re-fetch without the requests relation to avoid cascade issues on save
    // (same pattern upstream uses in MediaRequestSubscriber).
    const cleanMedia = await mediaRepository.findOneOrFail({
      where: { id: mediaId },
    });
    for (const is4k of qualities) {
      cleanMedia[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
      for (const season of cleanMedia.seasons ?? []) {
        season[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
      }
      cleanMedia.resetServiceData(is4k);
    }
    await mediaRepository.save(cleanMedia);

    logger.info('User removed their own requested media', {
      label: 'Media',
      mediaId,
      tmdbId: media.tmdbId,
      mediaType: media.mediaType,
      userId: user.id,
      qualities: qualities.map((is4k) => (is4k ? '4k' : 'standard')),
    });

    res.status(204).send();
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return next({ status: 404, message: 'Media not found' });
    }
    if (e instanceof OwnMediaDeletionError) {
      return next({ status: e.status, message: e.message });
    }
    logger.error('Something went wrong removing own media', {
      label: 'Media',
      mediaId,
      userId: user.id,
      message: e.message,
    });
    next({ status: 500, message: 'Failed to remove media' });
  }
};
