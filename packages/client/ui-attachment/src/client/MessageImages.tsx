import type { MessageImagesProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { ImageGallery } from '../MessageImage.tsx'
import { messageImageLabels } from './labels.ts'

/** Historical message-image slot entry. */
export function MessageImages({ images, loadImage, align, compact = false, t }: MessageImagesProps) {
  return (
    <ImageGallery
      images={images}
      load={loadImage}
      align={align}
      compact={compact}
      labels={messageImageLabels(t)}
    />
  )
}
