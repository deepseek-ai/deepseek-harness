/** Official image gallery Factory and default image Slot adapter. */
import { useMemo } from 'react'
import type { FactoryComponentPropsOf, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageImagesOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ImageGallery } from '../MessageImage.tsx'
import { messageImageLabels } from './labels.ts'

type MessageImagesProps = MessageImagesOwnerProps & PropsRenderFactories

/**
 * Render a gallery with an authorized loader and caller-owned or default labels.
 * @param props - image sources, authorized loader, layout hints, optional labels, and Factory locale seat.
 * @returns the official gallery; no Session binding is needed by this component.
 */
export function MessageImagesContent({ images, loadImage, align, compact = false, thumbnail = false, labels, t, fileDrag, useContextMenu }:
FactoryComponentPropsOf<'conversation.images.content'>) {
  const { getTriggerProps } = useContextMenu()
  const resolved = useMemo(() => labels ?? messageImageLabels(t), [labels, t])
  return <ImageGallery images={images} load={loadImage} align={align}
    compact={compact} thumbnail={thumbnail} labels={resolved} fileDrag={fileDrag} getTriggerProps={getTriggerProps} />
}

/**
 * Fill a message, trajectory, or tool image position through the shared Content Factory.
 * @param props - Slot owner image data, authorized loader, and framework Factory renderer.
 * @returns the official gallery occurrence.
 */
export function MessageImages({ images, loadImage, align, compact, thumbnail, renderFactorySlot }: MessageImagesProps) {
  return renderFactorySlot('conversation.images.content', {
    images, loadImage, align,
    ...compact === undefined ? {} : { compact },
    ...thumbnail === undefined ? {} : { thumbnail },
  })
}
