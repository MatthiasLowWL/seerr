import ConfirmButton from '@app/components/Common/ConfirmButton';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { TrashIcon } from '@heroicons/react/24/solid';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.DeleteOwnMediaButton', {
  removeownmedia: 'Remove from library',
  confirmremove: 'Delete files?',
  removesuccess: '<strong>{title}</strong> was removed from the library.',
  removefailed: 'Something went wrong while removing <strong>{title}</strong>.',
});

/**
 * Fork feature: a user who owns every request on a title can remove it,
 * files included. The server re-checks ownership, so this component only
 * decides whether the button is worth showing.
 */

type MediaLike = Pick<
  NonFunctionProperties<Media>,
  'id' | 'status' | 'status4k'
> & {
  requests?: Pick<
    NonFunctionProperties<MediaRequest>,
    'status' | 'requestedBy'
  >[];
};

interface DeleteOwnMediaButtonProps {
  media?: MediaLike | null;
  title: string;
  onUpdate: () => void;
  className?: string;
  /** Hide the text label on small screens (detail-page button row). */
  compact?: boolean;
}

const ACTIVE_STATUSES = [
  MediaStatus.PROCESSING,
  MediaStatus.PARTIALLY_AVAILABLE,
  MediaStatus.AVAILABLE,
];

const DeleteOwnMediaButton = ({
  media,
  title,
  onUpdate,
  className,
  compact = false,
}: DeleteOwnMediaButtonProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const settings = useSettings();
  const { user, hasPermission } = useUser();
  const [isRemoving, setIsRemoving] = useState(false);

  if (
    !media ||
    !user ||
    !settings.currentSettings.allowOwnMediaDeletion ||
    hasPermission(Permission.MANAGE_REQUESTS)
  ) {
    return null;
  }

  const requests = media.requests;
  // On the detail pages the media carries its requests, so we can hide the
  // button for shared titles up front. Request rows don't, so we show it and
  // let the server decide.
  if (requests) {
    if (requests.length === 0) {
      return null;
    }
    if (requests.some((r) => r.requestedBy?.id !== user.id)) {
      return null;
    }
    const hasApproved = requests.some(
      (r) =>
        r.status === MediaRequestStatus.APPROVED ||
        r.status === MediaRequestStatus.COMPLETED
    );
    const hasFiles =
      ACTIVE_STATUSES.includes(media.status) ||
      ACTIVE_STATUSES.includes(media.status4k);
    if (!hasApproved && !hasFiles) {
      return null;
    }
  }

  const removeMedia = async () => {
    if (isRemoving) {
      return;
    }
    setIsRemoving(true);
    try {
      await axios.delete(`/api/v1/media/${media.id}/own`);
      addToast(
        <span>
          {intl.formatMessage(messages.removesuccess, {
            title,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
      onUpdate();
    } catch (e) {
      const serverMessage =
        axios.isAxiosError(e) && typeof e.response?.data?.message === 'string'
          ? e.response.data.message
          : undefined;
      addToast(
        <span>
          {serverMessage ??
            intl.formatMessage(messages.removefailed, {
              title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
        </span>,
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setIsRemoving(false);
    }
  };

  return (
    <ConfirmButton
      onClick={removeMedia}
      confirmText={intl.formatMessage(messages.confirmremove)}
      className={className}
    >
      <TrashIcon />
      <span className={compact ? 'hidden sm:inline' : undefined}>
        {intl.formatMessage(messages.removeownmedia)}
      </span>
    </ConfirmButton>
  );
};

export default DeleteOwnMediaButton;
