import type { ReactNode } from 'react'
import { ICON_MEDIUM_STROKE, ICON_REGULAR_STROKE } from './icons/index.tsx'
import type { IconProps } from './icons/props.ts'

interface PermissionIconArtworkProps extends IconProps {
  strokeWidth: number
}

function ReadOnlyArtwork({ size = 16, className, strokeWidth }: PermissionIconArtworkProps): ReactNode {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
      <path d="M5.08545 8.13775L7.18455 10.2368C7.26636 10.3187 7.4003 10.3142 7.47649 10.2271L11.5148 5.61194" stroke="currentColor" />
      <path d="M6.59624 2.14853C7.50155 1.80917 8.49914 1.80919 9.40444 2.14859L13.9245 3.84317V7.11961C13.9245 11.6089 10.5565 13.5975 8.00035 14.5779C5.44423 13.5975 2.07544 11.6089 2.07544 7.11961V3.84317L6.59624 2.14853Z" stroke="currentColor" strokeLinejoin="round" />
    </svg>
  )
}

function WorkspaceWriteArtwork({ size = 16, className, strokeWidth }: PermissionIconArtworkProps): ReactNode {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
      <path d="M6.4209 1.68067C7.43922 1.299 8.56177 1.29898 9.58008 1.68067L14.0996 3.375C14.2946 3.44811 14.4236 3.63455 14.4238 3.84278V6.89063C14.1115 6.71853 13.7761 6.58312 13.4238 6.48926V4.18946L9.22852 2.61621C8.43657 2.31947 7.56341 2.31939 6.77148 2.61621L2.5752 4.18946V7.11914C2.5752 11.1796 5.52369 13.056 8 14.0391C8.27653 13.9293 8.55827 13.8067 8.8418 13.6729C9.07101 13.9468 9.33228 14.1929 9.62012 14.4053C9.12409 14.6579 8.63578 14.8696 8.17871 15.0449C8.0637 15.0889 7.93628 15.0889 7.82129 15.0449C5.22011 14.0472 1.5752 11.9381 1.5752 7.11914V3.84278C1.57541 3.63469 1.70463 3.44821 1.89941 3.375L6.4209 1.68067Z" fill="currentColor" />
      <path d="M5.26392 6.60339H10.7361" stroke="currentColor" />
      <path d="M5.26392 9.86902H8.32833" stroke="currentColor" />
      <path d="M10.0317 13.2229C10.263 13.3929 10.4943 13.563 10.7256 13.733C10.7932 13.6482 10.8608 13.5634 10.9284 13.4786C12.1455 11.9522 13.3626 10.4258 14.5798 8.89935C14.6474 8.81455 14.715 8.72975 14.7826 8.64495C14.4143 8.37419 14.046 8.10344 13.6777 7.83268C13.6169 7.92252 13.5562 8.01236 13.4954 8.10219C12.4016 9.71926 11.3078 11.3363 10.214 12.9534C10.1532 13.0432 10.0924 13.1331 10.0317 13.2229Z" fill="currentColor" />
      <path d="M12.6516 12.6696C12.6516 12.925 12.6516 13.1804 12.6516 13.4359C12.6952 13.4378 12.7387 13.4398 12.7823 13.4417C13.5663 13.4768 14.3504 13.5118 15.1345 13.5469C15.178 13.5488 15.2216 13.5508 15.2651 13.5527C15.2651 13.2194 15.2651 12.8861 15.2651 12.5527C15.2216 12.5547 15.178 12.5566 15.1345 12.5586C14.3504 12.5936 13.5663 12.6287 12.7823 12.6637C12.7387 12.6657 12.6952 12.6676 12.6516 12.6696Z" fill="currentColor" />
    </svg>
  )
}

function FullAccessArtwork({ size = 16, className, strokeWidth }: PermissionIconArtworkProps): ReactNode {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
      <path d="M6.59624 2.14853C7.50155 1.80917 8.49914 1.80919 9.40444 2.14859L13.9245 3.84317V7.11961C13.9245 11.6089 10.5565 13.5975 8.00035 14.5779C5.44423 13.5975 2.07544 11.6089 2.07544 7.11961V3.84317L6.59624 2.14853Z" stroke="currentColor" strokeLinejoin="round" />
      <path d="M8 4.39209V9.89209" stroke="currentColor" />
      <path d="M8 10.8081V11.8081" stroke="currentColor" />
    </svg>
  )
}

/**
 * Render the read-only permission icon with a one-pixel stroke.
 * @param props - Size and optional class.
 * @returns The regular decorative permission glyph.
 */
export function PermissionIconReadOnlyRegular(props: IconProps): ReactNode {
  return <ReadOnlyArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
}

/**
 * Render the read-only permission icon with a 1.3px stroke.
 * @param props - Size and optional class.
 * @returns The medium decorative permission glyph.
 */
export function PermissionIconReadOnlyMedium(props: IconProps): ReactNode {
  return <ReadOnlyArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
}

/**
 * Render the workspace-write permission icon with a one-pixel stroke.
 * @param props - Size and optional class.
 * @returns The regular decorative permission glyph.
 */
export function PermissionIconWorkspaceWriteRegular(props: IconProps): ReactNode {
  return <WorkspaceWriteArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
}

/**
 * Render the workspace-write permission icon with a 1.3px stroke.
 * @param props - Size and optional class.
 * @returns The medium decorative permission glyph.
 */
export function PermissionIconWorkspaceWriteMedium(props: IconProps): ReactNode {
  return <WorkspaceWriteArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
}

/**
 * Render the full-access permission icon with a one-pixel stroke.
 * @param props - Size and optional class.
 * @returns The regular decorative permission glyph.
 */
export function PermissionIconFullAccessRegular(props: IconProps): ReactNode {
  return <FullAccessArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
}

/**
 * Render the full-access permission icon with a 1.3px stroke.
 * @param props - Size and optional class.
 * @returns The medium decorative permission glyph.
 */
export function PermissionIconFullAccessMedium(props: IconProps): ReactNode {
  return <FullAccessArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
}
