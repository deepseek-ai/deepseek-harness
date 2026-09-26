/**
 * Shared current-color product icons. Names identify the glyph and weight;
 * rendered size remains a prop instead of part of the component name.
 */
import { useId } from 'react'
import type { IconProps } from './props.ts'
import {
  BrowseOutlineArtwork, ChatLinesOutlineArtwork, CodeBracketsArtwork, FolderCloseArtwork,
  GlobeOutlineArtwork, NewChatOutlineArtwork,
} from './shared-artwork.tsx'

export type { IconProps } from './props.ts'

interface WeightedIconProps extends IconProps {
  strokeWidth: number
}

/** Shared shield contour used by composite icons outside this module. */
export const SHIELD_OUTLINE_PATH = 'M6.80132 2.14853C7.70663 1.80917 8.70422 1.80919 9.60952 2.14859L14.1296 3.84317V7.11961C14.1296 11.6089 10.7615 13.5975 8.20543 14.5779C5.64931 13.5975 2.28052 11.6089 2.28052 7.11961V3.84317L6.80132 2.14853Z'

/** Regular stroke width used by the product icon set. */
export const ICON_REGULAR_STROKE = 1

/** Medium stroke width used by emphasized product icons. */
export const ICON_MEDIUM_STROKE = 1.3

/** Regular one-pixel IconNewChatOutline artwork. */
export const IconNewChatOutlineRegular = (props: IconProps) => (
  <NewChatOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconNewChatOutline artwork with a 1.3px stroke. */
export const IconNewChatOutlineMedium = (props: IconProps) => (
  <NewChatOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconSearchOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z" stroke="currentColor" />
    <path d="M10.2991 10.3933L14.7783 14.8725" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconSearchOutline artwork. */
export const IconSearchOutlineRegular = (props: IconProps) => (
  <IconSearchOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconSearchOutline artwork with a 1.3px stroke. */
export const IconSearchOutlineMedium = (props: IconProps) => (
  <IconSearchOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

/** Regular one-pixel IconGlobeOutline artwork. */
export const IconGlobeOutlineRegular = (props: IconProps) => (
  <GlobeOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconGlobeOutline artwork with a 1.3px stroke. */
export const IconGlobeOutlineMedium = (props: IconProps) => (
  <GlobeOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconSettingsOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M8 9.75012C8.9665 9.75012 9.75 8.96662 9.75 8.00012C9.75 7.03362 8.9665 6.25012 8 6.25012C7.0335 6.25012 6.25 7.03362 6.25 8.00012C6.25 8.96662 7.0335 9.75012 8 9.75012Z" stroke="currentColor" />
    <path d="M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951C12.9205 8.0549 12.9505 8.10502 13.0106 8.20528L13.9849 9.83006C14.045 9.93029 14.0751 9.9804 14.0751 10.0358C14.0751 10.0911 14.045 10.1413 13.9849 10.2415L13.0037 11.8777C12.9468 11.9726 12.9184 12.0201 12.8725 12.0461C12.8267 12.072 12.7713 12.072 12.6607 12.072H10.6704C10.5598 12.072 10.5045 12.072 10.4586 12.098C10.4128 12.1239 10.3843 12.1714 10.3274 12.2662L9.33825 13.9142C9.28133 14.009 9.25287 14.0564 9.20703 14.0823C9.16118 14.1083 9.10588 14.1083 8.99529 14.1083H7.00486C6.89426 14.1083 6.83896 14.1083 6.79312 14.0823C6.74727 14.0564 6.71881 14.009 6.6619 13.9142L5.67273 12.2662C5.61581 12.1714 5.58735 12.1239 5.54151 12.098C5.49566 12.072 5.44036 12.072 5.32977 12.072H3.33945C3.2288 12.072 3.17347 12.072 3.12761 12.0461C3.08176 12.0201 3.0533 11.9726 2.9964 11.8777L2.0152 10.2415C1.9551 10.1413 1.92505 10.0911 1.92505 10.0358C1.92505 9.9804 1.9551 9.93029 2.0152 9.83006L2.98951 8.20528C3.04963 8.10502 3.07969 8.0549 3.07969 7.99951C3.07968 7.94413 3.04961 7.89401 2.98946 7.79377L2.01529 6.17011C1.95514 6.06987 1.92507 6.01975 1.92507 5.96437C1.92506 5.90899 1.95512 5.85886 2.01524 5.7586L2.9964 4.1224C3.0533 4.0275 3.08176 3.98005 3.12761 3.95408C3.17347 3.92811 3.2288 3.92811 3.33945 3.92811H5.32977C5.44036 3.92811 5.49566 3.92811 5.54151 3.90216C5.58735 3.87621 5.61581 3.82879 5.67273 3.73397L6.6619 2.08599C6.71881 1.99116 6.74727 1.94375 6.79312 1.9178C6.83896 1.89185 6.89426 1.89185 7.00486 1.89185H8.99529C9.10588 1.89185 9.16118 1.89185 9.20703 1.9178C9.25287 1.94375 9.28133 1.99116 9.33825 2.08599L10.3274 3.73397C10.3843 3.82879 10.4128 3.87621 10.4586 3.90216C10.5045 3.92811 10.5598 3.92811 10.6704 3.92811H12.6607C12.7713 3.92811 12.8267 3.92811 12.8725 3.95408C12.9184 3.98005 12.9468 4.0275 13.0037 4.1224L13.9849 5.7586C14.045 5.85886 14.0751 5.90899 14.0751 5.96437C14.0751 6.01975 14.045 6.06987 13.9849 6.17011L13.0107 7.79377Z" stroke="currentColor" strokeMiterlimit="10" />
  </svg>
)

/** Regular one-pixel IconSettingsOutline artwork. */
export const IconSettingsOutlineRegular = (props: IconProps) => (
  <IconSettingsOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconSettingsOutline artwork with a 1.3px stroke. */
export const IconSettingsOutlineMedium = (props: IconProps) => (
  <IconSettingsOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconPanelLeftOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z" stroke="currentColor" />
    <path d="M5.5 1.5V14.5" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconPanelLeftOutline artwork. */
export const IconPanelLeftOutlineRegular = (props: IconProps) => (
  <IconPanelLeftOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconPanelLeftOutline artwork with a 1.3px stroke. */
export const IconPanelLeftOutlineMedium = (props: IconProps) => (
  <IconPanelLeftOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconEllipsisOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M3 9C3.55228 9 4 8.55228 4 8C4 7.44772 3.55228 7 3 7C2.44772 7 2 7.44772 2 8C2 8.55228 2.44772 9 3 9Z" fill="currentColor" />
    <path d="M8 9C8.55228 9 9 8.55228 9 8C9 7.44772 8.55228 7 8 7C7.44772 7 7 7.44772 7 8C7 8.55228 7.44772 9 8 9Z" fill="currentColor" />
    <path d="M13 9C13.5523 9 14 8.55228 14 8C14 7.44772 13.5523 7 13 7C12.4477 7 12 7.44772 12 8C12 8.55228 12.4477 9 13 9Z" fill="currentColor" />
  </svg>
)

/** Regular IconEllipsisOutline artwork; its fill-only geometry is weight-independent. */
export const IconEllipsisOutlineRegular = (props: IconProps) => (
  <IconEllipsisOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconEllipsisOutline artwork; it matches Regular because the geometry is fill-only. */
export const IconEllipsisOutlineMedium = (props: IconProps) => (
  <IconEllipsisOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconPlusOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M8 2V14" stroke="currentColor" />
    <path d="M2 8H14" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconPlusOutline artwork. */
export const IconPlusOutlineRegular = (props: IconProps) => (
  <IconPlusOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconPlusOutline artwork with a 1.3px stroke. */
export const IconPlusOutlineMedium = (props: IconProps) => (
  <IconPlusOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconCheckOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconCheckOutline artwork. */
export const IconCheckOutlineRegular = (props: IconProps) => (
  <IconCheckOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconCheckOutline artwork with a 1.3px stroke. */
export const IconCheckOutlineMedium = (props: IconProps) => (
  <IconCheckOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconBranchOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M1.01503 8.0001L5.6964 8.0001C6.41913 8.0001 6.78049 8.0001 7.12115 7.91951C7.4232 7.84804 7.71233 7.73014 7.97821 7.57C8.27809 7.38939 8.5364 7.13669 9.05303 6.63129L11.3281 4.40564" stroke="currentColor" />
    <path d="M1.01221 7.9999L5.6964 7.9999C6.41913 7.9999 6.78049 7.9999 7.12115 8.08049C7.4232 8.15196 7.71233 8.26986 7.97821 8.43C8.27809 8.61061 8.5364 8.86331 9.05303 9.36871L11.3281 11.5944" stroke="currentColor" />
    <circle cx="12.4502" cy="3.3079" r="1.56962" stroke="currentColor" />
    <circle cx="12.4502" cy="12.6921" r="1.56962" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconBranchOutline artwork. */
export const IconBranchOutlineRegular = (props: IconProps) => (
  <IconBranchOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconBranchOutline artwork with a 1.3px stroke. */
export const IconBranchOutlineMedium = (props: IconProps) => (
  <IconBranchOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconChevronDownOutlineArtwork = ({ size = 14, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconChevronDownOutline artwork. */
export const IconChevronDownOutlineRegular = (props: IconProps) => (
  <IconChevronDownOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconChevronDownOutline artwork with a 1.3px stroke. */
export const IconChevronDownOutlineMedium = (props: IconProps) => (
  <IconChevronDownOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconChevronLeftOutlineArtwork = ({ size = 14, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M10 4L6.70711 7.29289C6.31658 7.68342 6.31658 8.31658 6.70711 8.70711L10 12" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconChevronLeftOutline artwork. */
export const IconChevronLeftOutlineRegular = (props: IconProps) => (
  <IconChevronLeftOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconChevronLeftOutline artwork with a 1.3px stroke. */
export const IconChevronLeftOutlineMedium = (props: IconProps) => (
  <IconChevronLeftOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconChevronRightOutlineArtwork = ({ size = 14, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconChevronRightOutline artwork. */
export const IconChevronRightOutlineRegular = (props: IconProps) => (
  <IconChevronRightOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconChevronRightOutline artwork with a 1.3px stroke. */
export const IconChevronRightOutlineMedium = (props: IconProps) => (
  <IconChevronRightOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconTriangleRightFillArtwork = ({ size = 14, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M5.5 4.5C5.5 4.40714 5.52586 4.31612 5.57467 4.23713C5.62349 4.15815 5.69334 4.09431 5.77639 4.05279C5.85945 4.01126 5.95242 3.99368 6.0449 4.00202C6.13738 4.01036 6.22572 4.04429 6.3 4.1L10.967 7.6C11.0291 7.64657 11.0795 7.70697 11.1142 7.77639C11.1489 7.84582 11.167 7.92238 11.167 8C11.167 8.07762 11.1489 8.15418 11.1142 8.22361C11.0795 8.29303 11.0291 8.35343 10.967 8.4L6.3 11.9C6.22572 11.9557 6.13738 11.9896 6.0449 11.998C5.95242 12.0063 5.85945 11.9887 5.77639 11.9472C5.69334 11.9057 5.62349 11.8419 5.57467 11.7629C5.52586 11.6839 5.5 11.5929 5.5 11.5V4.5Z" fill="currentColor" />
  </svg>
)

/** Regular IconTriangleRightFill artwork; its fill-only geometry is weight-independent. */
export const IconTriangleRightFillRegular = (props: IconProps) => (
  <IconTriangleRightFillArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconTriangleRightFill artwork; it matches Regular because the geometry is fill-only. */
export const IconTriangleRightFillMedium = (props: IconProps) => (
  <IconTriangleRightFillArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconChevronUpOutlineArtwork = ({ size = 14, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M12 10L8.70711 6.70711C8.31658 6.31658 7.68342 6.31658 7.29289 6.70711L4 10" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconChevronUpOutline artwork. */
export const IconChevronUpOutlineRegular = (props: IconProps) => (
  <IconChevronUpOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconChevronUpOutline artwork with a 1.3px stroke. */
export const IconChevronUpOutlineMedium = (props: IconProps) => (
  <IconChevronUpOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconCloseOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M2.5 2.5L13.5 13.5" stroke="currentColor" />
    <path d="M13.5 2.5L2.5 13.5" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconCloseOutline artwork. */
export const IconCloseOutlineRegular = (props: IconProps) => (
  <IconCloseOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconCloseOutline artwork with a 1.3px stroke. */
export const IconCloseOutlineMedium = (props: IconProps) => (
  <IconCloseOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconCloseFillArtwork = ({ size = 14, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M3.5 3.5L12.5 12.5" stroke="currentColor" />
    <path d="M12.5 3.5L3.5 12.5" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconCloseFill artwork. */
export const IconCloseFillRegular = (props: IconProps) => (
  <IconCloseFillArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconCloseFill artwork with a 1.3px stroke. */
export const IconCloseFillMedium = (props: IconProps) => (
  <IconCloseFillArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

// A 7-unit disc with the cross knocked out of it (even-odd), so the cross
// takes the color of whatever sits behind the glyph.
const IconCloseCircleFillArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path fillRule="evenodd" clipRule="evenodd" d="M15 8A7 7 0 1 1 1 8A7 7 0 1 1 15 8ZM6.409 10.652L5.348 9.591L6.939 8L5.348 6.409L6.409 5.348L8 6.939L9.591 5.348L10.652 6.409L9.061 8L10.652 9.591L9.591 10.652L8 9.061Z" fill="currentColor" />
  </svg>
)

/** Regular IconCloseCircleFill artwork (cross knocked out of a filled disc); its fill-only geometry is weight-independent. */
export const IconCloseCircleFillRegular = (props: IconProps) => (
  <IconCloseCircleFillArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconCloseCircleFill artwork; it matches Regular because the geometry is fill-only. */
export const IconCloseCircleFillMedium = (props: IconProps) => (
  <IconCloseCircleFillArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconCopyOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <rect x="1.52075" y="4.07373" width="10.3932" height="10.3932" rx="2" stroke="currentColor" />
    <path d="M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z" fill="currentColor" />
  </svg>
)

/** Regular one-pixel IconCopyOutline artwork. */
export const IconCopyOutlineRegular = (props: IconProps) => (
  <IconCopyOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconCopyOutline artwork with a 1.3px stroke. */
export const IconCopyOutlineMedium = (props: IconProps) => (
  <IconCopyOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconRefreshOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1" stroke="currentColor" />
    <path d="M14.4999 1.5V5.1H10.8999" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconRefreshOutline artwork. */
export const IconRefreshOutlineRegular = (props: IconProps) => (
  <IconRefreshOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconRefreshOutline artwork with a 1.3px stroke. */
export const IconRefreshOutlineMedium = (props: IconProps) => (
  <IconRefreshOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconLikeOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M13.537 8.12098L12.3983 12.8455C12.1818 13.7438 11.378 14.3769 10.454 14.3769L9.35595 14.3769H7.43799H5.16577C3.50892 14.3769 2.16577 13.0337 2.16577 11.3769V7.88668C2.16577 7.33439 2.61349 6.88668 3.16577 6.88668H4.02665C5.84943 6.88668 7.38083 3.28711 7.67689 2.54578C7.71259 2.45639 7.73501 2.36373 7.77922 2.27824C7.86506 2.11221 8.08228 1.87578 8.59039 2.07775C10.3291 2.76886 9.23144 6.04071 8.96955 6.75058C8.94502 6.81707 8.99495 6.88668 9.06581 6.88668H12.5648C13.2119 6.88668 13.6886 7.49192 13.537 8.12098Z" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconLikeOutline artwork. */
export const IconLikeOutlineRegular = (props: IconProps) => (
  <IconLikeOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconLikeOutline artwork with a 1.3px stroke. */
export const IconLikeOutlineMedium = (props: IconProps) => (
  <IconLikeOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconLikeFillArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M13.537 8.12098L12.3983 12.8455C12.1818 13.7438 11.378 14.3769 10.454 14.3769L9.35595 14.3769H7.43799H5.16577C3.50892 14.3769 2.16577 13.0337 2.16577 11.3769V7.88668C2.16577 7.33439 2.61349 6.88668 3.16577 6.88668H4.02665C5.84943 6.88668 7.38083 3.28711 7.67689 2.54578C7.71259 2.45639 7.73501 2.36373 7.77922 2.27824C7.86506 2.11221 8.08228 1.87578 8.59039 2.07775C10.3291 2.76886 9.23144 6.04071 8.96955 6.75058C8.94502 6.81707 8.99495 6.88668 9.06581 6.88668H12.5648C13.2119 6.88668 13.6886 7.49192 13.537 8.12098Z" fill="currentColor" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconLikeFill artwork. */
export const IconLikeFillRegular = (props: IconProps) => (
  <IconLikeFillArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconLikeFill artwork with a 1.3px stroke. */
export const IconLikeFillMedium = (props: IconProps) => (
  <IconLikeFillArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconDislikeOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M2.46302 8.06749L3.60171 3.34299C3.81822 2.44467 4.62196 1.81162 5.546 1.8116L6.64406 1.81158L8.56202 1.81158L10.8342 1.81158C12.4911 1.81158 13.8342 3.15473 13.8342 4.81158L13.8342 8.3018C13.8342 8.85408 13.3865 9.3018 12.8342 9.3018L11.9734 9.3018C10.1506 9.3018 8.61918 12.9014 8.32311 13.6427C8.28741 13.7321 8.26499 13.8247 8.22078 13.9102C8.13494 14.0763 7.91772 14.3127 7.40961 14.1107C5.67089 13.4196 6.76856 10.1478 7.03045 9.43789C7.05498 9.37141 7.00505 9.3018 6.93419 9.3018L3.43519 9.3018C2.78811 9.3018 2.31141 8.69656 2.46302 8.06749Z" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconDislikeOutline artwork. */
export const IconDislikeOutlineRegular = (props: IconProps) => (
  <IconDislikeOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconDislikeOutline artwork with a 1.3px stroke. */
export const IconDislikeOutlineMedium = (props: IconProps) => (
  <IconDislikeOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconDislikeFillArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M2.46302 8.06749L3.60171 3.34299C3.81822 2.44467 4.62196 1.81162 5.546 1.8116L6.64406 1.81158L8.56202 1.81158L10.8342 1.81158C12.4911 1.81158 13.8342 3.15473 13.8342 4.81158L13.8342 8.3018C13.8342 8.85408 13.3865 9.3018 12.8342 9.3018L11.9734 9.3018C10.1506 9.3018 8.61918 12.9014 8.32311 13.6427C8.28741 13.7321 8.26499 13.8247 8.22078 13.9102C8.13494 14.0763 7.91772 14.3127 7.40961 14.1107C5.67089 13.4196 6.76856 10.1478 7.03045 9.43789C7.05498 9.37141 7.00505 9.3018 6.93419 9.3018L3.43519 9.3018C2.78811 9.3018 2.31141 8.69656 2.46302 8.06749Z" fill="currentColor" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconDislikeFill artwork. */
export const IconDislikeFillRegular = (props: IconProps) => (
  <IconDislikeFillArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconDislikeFill artwork with a 1.3px stroke. */
export const IconDislikeFillMedium = (props: IconProps) => (
  <IconDislikeFillArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconShareOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M14.1256 7.58723C14.3483 7.81942 14.3482 8.18589 14.1254 8.41799L8.6646 14.1077C8.53985 14.2377 8.32031 14.1494 8.32031 13.9692L8.32035 10.2039C8.32035 10.1943 8.31534 10.1864 8.30592 10.1849C8.08306 10.148 5.30067 9.7729 1.50993 13.2904C1.49711 13.3023 1.47561 13.2943 1.4757 13.2768C1.49273 9.87168 3.42001 5.07166 8.29999 5.05835C8.31103 5.05832 8.32035 5.04937 8.32035 5.03832L8.32031 2.03109C8.32031 1.85088 8.53993 1.76259 8.66466 1.89266L14.1256 7.58723Z" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconShareOutline artwork. */
export const IconShareOutlineRegular = (props: IconProps) => (
  <IconShareOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconShareOutline artwork with a 1.3px stroke. */
export const IconShareOutlineMedium = (props: IconProps) => (
  <IconShareOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconDeliverDocArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M6.15479 4.91687H9.84543" stroke="currentColor" />
    <path d="M11.8798 9.55347V2.71525C11.8798 2.37416 11.564 2.09766 11.1744 2.09766H4.82577C4.43618 2.09766 4.12036 2.37416 4.12036 2.71525V9.55347" stroke="currentColor" />
    <path d="M2.28735 13.8022V8.84792C2.28735 8.77514 2.36262 8.72673 2.42884 8.75693L13.2936 13.7112C13.3914 13.7558 13.3596 13.9022 13.2521 13.9022H2.38735C2.33213 13.9022 2.28735 13.8575 2.28735 13.8022Z" stroke="currentColor" />
    <path d="M7.46929 10.979L13.5783 8.7416C13.6435 8.7177 13.7126 8.76601 13.7126 8.83551L13.7125 13.8022C13.7125 13.8574 13.6678 13.9022 13.6125 13.9022H7.99999" stroke="currentColor" />
    <path d="M6.15479 7.2395H9.05644" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconDeliverDoc artwork. */
export const IconDeliverDocRegular = (props: IconProps) => (
  <IconDeliverDocArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconDeliverDoc artwork with a 1.3px stroke. */
export const IconDeliverDocMedium = (props: IconProps) => (
  <IconDeliverDocArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconEditOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z" fill="currentColor" />
    <path d="M7.7849 8.23878L13.888 2.13574" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconEditOutline artwork. */
export const IconEditOutlineRegular = (props: IconProps) => (
  <IconEditOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconEditOutline artwork with a 1.3px stroke. */
export const IconEditOutlineMedium = (props: IconProps) => (
  <IconEditOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconThinkOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M10.7554 5.24466C13.9891 8.4783 15.3769 12.3333 13.8552 13.8551C12.3335 15.3768 8.4785 13.989 5.24478 10.7553C2.01111 7.52165 0.623307 3.66664 2.14504 2.14491C3.66676 0.623189 7.52178 2.01099 10.7554 5.24466Z" stroke="currentColor" />
    <path d="M10.7554 10.7553C7.52178 13.989 3.66676 15.3768 2.14504 13.8551C0.623307 12.3333 2.01111 8.4783 5.24478 5.24466C8.4785 2.01099 12.3335 0.623189 13.8552 2.14491C15.3769 3.66664 13.9891 7.52165 10.7554 10.7553Z" stroke="currentColor" />
    <path d="M8.9587 8.00025C8.9587 8.52835 8.5306 8.95655 8.0024 8.95655C7.47429 8.95655 7.04614 8.52835 7.04614 8.00025C7.04614 7.47209 7.47429 7.04395 8.0024 7.04395C8.5306 7.04395 8.9587 7.47209 8.9587 8.00025Z" fill="currentColor" />
  </svg>
)

/** Regular one-pixel IconThinkOutline artwork. */
export const IconThinkOutlineRegular = (props: IconProps) => (
  <IconThinkOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconThinkOutline artwork with a 1.3px stroke. */
export const IconThinkOutlineMedium = (props: IconProps) => (
  <IconThinkOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconAgentPresetOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M6.51867 12.3282C7.29816 12.6011 8.16475 12.6514 9.02269 12.4216C9.57879 12.2726 10.0784 12.0185 10.5087 11.6888C10.7819 12.0555 11.1606 12.3304 11.5913 12.4805C10.9688 13.029 10.2149 13.4478 9.35911 13.6771C8.13946 14.0038 6.90632 13.8971 5.82126 13.4533C6.15821 13.1562 6.4021 12.7652 6.51867 12.3282ZM9.17629 2.89409C11.1101 3.34433 12.739 4.81872 13.2889 6.87043C13.4219 7.3665 13.4811 7.8649 13.4774 8.35466C13.0924 8.13213 12.6422 8.01837 12.1741 8.05276L12.1711 8.05257C12.1539 7.77199 12.109 7.48889 12.0334 7.20684C11.6363 5.72533 10.5048 4.6372 9.13549 4.22844C9.25559 3.87667 9.29214 3.49087 9.22309 3.09892C9.2108 3.02922 9.19451 2.96108 9.17629 2.89409ZM4.7311 3.89107L4.78302 4.11879C4.87648 4.4488 5.04146 4.74263 5.25579 4.98896C3.98078 6.01355 3.35848 7.72904 3.8089 9.41059C3.81828 9.44559 3.82866 9.48025 3.83885 9.51479C3.38217 9.61268 2.98548 9.84137 2.68107 10.1556C2.63414 10.022 2.5897 9.88632 2.55244 9.74726C1.93301 7.43489 2.86717 5.07173 4.71504 3.76697L4.7311 3.89107Z" fill="currentColor" />
    <path d="M7.99136 5.28105C8.87501 5.28105 9.59136 4.56471 9.59136 3.68105C9.59136 2.7974 8.87501 2.08105 7.99136 2.08105C7.1077 2.08105 6.39136 2.7974 6.39136 3.68105C6.39136 4.56471 7.1077 5.28105 7.99136 5.28105Z" stroke="currentColor" />
    <path d="M3.94009 12.9417C4.82374 12.9417 5.54009 12.2254 5.54009 11.3417C5.54009 10.458 4.82374 9.7417 3.94009 9.7417C3.05643 9.7417 2.34009 10.458 2.34009 11.3417C2.34009 12.2254 3.05643 12.9417 3.94009 12.9417Z" stroke="currentColor" />
    <path d="M12.0851 12.9417C12.9688 12.9417 13.6851 12.2254 13.6851 11.3417C13.6851 10.458 12.9688 9.7417 12.0851 9.7417C11.2015 9.7417 10.4851 10.458 10.4851 11.3417C10.4851 12.2254 11.2015 12.9417 12.0851 12.9417Z" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconAgentPresetOutline artwork. */
export const IconAgentPresetOutlineRegular = (props: IconProps) => (
  <IconAgentPresetOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconAgentPresetOutline artwork with a 1.3px stroke. */
export const IconAgentPresetOutlineMedium = (props: IconProps) => (
  <IconAgentPresetOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

/** Regular one-pixel IconBrowseOutline artwork. */
export const IconBrowseOutlineRegular = (props: IconProps) => (
  <BrowseOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconBrowseOutline artwork with a 1.3px stroke. */
export const IconBrowseOutlineMedium = (props: IconProps) => (
  <BrowseOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconContextInjectionOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M5 2.5H3.5C3.23478 2.5 2.98043 2.60536 2.79289 2.79289C2.60536 2.98043 2.5 3.23478 2.5 3.5V13.5C2.5 13.7652 2.60536 14.0196 2.79289 14.2071C2.98043 14.3946 3.23478 14.5 3.5 14.5H12.5C12.7652 14.5 13.0196 14.3946 13.2071 14.2071C13.3946 14.0196 13.5 13.7652 13.5 13.5V3.5C13.5 3.23478 13.3946 2.98043 13.2071 2.79289C13.0196 2.60536 12.7652 2.5 12.5 2.5H11" stroke="currentColor" />
    <path d="M8 0.5V7.5" stroke="currentColor" />
    <path d="M5.5 5L8 7.5L10.5 5" stroke="currentColor" />
    <path d="M5.5 11H10.5" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconContextInjectionOutline artwork. */
export const IconContextInjectionOutlineRegular = (props: IconProps) => (
  <IconContextInjectionOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconContextInjectionOutline artwork with a 1.3px stroke. */
export const IconContextInjectionOutlineMedium = (props: IconProps) => (
  <IconContextInjectionOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconLinkOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M6.59961 9.40051C6.82779 9.6334 7.10015 9.81842 7.40074 9.94472C7.70132 10.071 8.02409 10.1361 8.35013 10.1361C8.67618 10.1361 8.99894 10.071 9.29953 9.94472C9.60011 9.81842 9.87247 9.6334 10.1007 9.40051L12.9015 6.59967C13.3658 6.13541 13.6266 5.50572 13.6266 4.84915C13.6266 4.19258 13.3658 3.56289 12.9015 3.09863C12.4372 2.63436 11.8075 2.37354 11.151 2.37354C10.4944 2.37354 9.86472 2.63436 9.40045 3.09863L9.05034 3.44873" stroke="currentColor" />
    <path d="M9.40051 6.59959C9.17233 6.3667 8.89997 6.18169 8.59939 6.05538C8.2988 5.92907 7.97603 5.86401 7.64999 5.86401C7.32395 5.86401 7.00118 5.92907 6.70059 6.05538C6.40001 6.18169 6.12765 6.3667 5.89946 6.59959L3.09863 9.40043C2.63436 9.8647 2.37354 10.4944 2.37354 11.151C2.37354 11.8075 2.63436 12.4372 3.09863 12.9015C3.56289 13.3657 4.19258 13.6266 4.84915 13.6266C5.50572 13.6266 6.13541 13.3657 6.59967 12.9015L6.94978 12.5514" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconLinkOutline artwork. */
export const IconLinkOutlineRegular = (props: IconProps) => (
  <IconLinkOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconLinkOutline artwork with a 1.3px stroke. */
export const IconLinkOutlineMedium = (props: IconProps) => (
  <IconLinkOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconRightUpOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M11.7256 2.77441C12.5538 2.77469 13.2256 3.44616 13.2256 4.27441V10.1416H12.2256V4.27441C12.2256 3.99844 12.0015 3.77469 11.7256 3.77441H5.7207V2.77441H11.7256Z" fill="currentColor" />
    <path d="M2.77441 13.2255L12.3756 3.62427" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconRightUpOutline artwork. */
export const IconRightUpOutlineRegular = (props: IconProps) => (
  <IconRightUpOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconRightUpOutline artwork with a 1.3px stroke. */
export const IconRightUpOutlineMedium = (props: IconProps) => (
  <IconRightUpOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconEnhanceOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M1.98486 2.95374H14.0151" stroke="currentColor" />
    <path d="M1.98486 6.31787H14.0151" stroke="currentColor" />
    <path d="M1.98486 9.68213H14.0151" stroke="currentColor" />
    <path d="M1.98486 13.0463H8.4627" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconEnhanceOutline artwork. */
export const IconEnhanceOutlineRegular = (props: IconProps) => (
  <IconEnhanceOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconEnhanceOutline artwork with a 1.3px stroke. */
export const IconEnhanceOutlineMedium = (props: IconProps) => (
  <IconEnhanceOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconTrashOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M1.28149 3.88831H14.7187" stroke="currentColor" />
    <path d="M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833" stroke="currentColor" />
    <path d="M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831" stroke="currentColor" />
    <path d="M6.44946 6.98926V11.1238" stroke="currentColor" />
    <path d="M9.55054 6.98926V11.1238" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconTrashOutline artwork. */
export const IconTrashOutlineRegular = (props: IconProps) => (
  <IconTrashOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconTrashOutline artwork with a 1.3px stroke. */
export const IconTrashOutlineMedium = (props: IconProps) => (
  <IconTrashOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconWarningOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z" stroke="currentColor" />
    <path d="M8 4.29199V9.79199" stroke="currentColor" />
    <path d="M8 10.708V11.708" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconWarningOutline artwork. */
export const IconWarningOutlineRegular = (props: IconProps) => (
  <IconWarningOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconWarningOutline artwork with a 1.3px stroke. */
export const IconWarningOutlineMedium = (props: IconProps) => (
  <IconWarningOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconCheckCircleFillArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M28.1936 14.6936L19.8066 23.0806C19.2373 23.65 18.7159 24.1742 18.24 24.5571C17.7389 24.9602 17.1365 25.3359 16.3657 25.458C15.9581 25.5225 15.5428 25.5225 15.1353 25.458C14.3645 25.3359 13.7621 24.9602 13.261 24.5571C12.7851 24.1742 12.2637 23.65 11.6943 23.0806L7.80737 19.1936L10.1936 16.8074L14.0806 20.6943C14.7033 21.317 15.0763 21.6873 15.377 21.9292C15.6523 22.1507 15.7109 22.1325 15.6626 22.1248C15.7208 22.1339 15.7802 22.1339 15.8384 22.1248C15.7901 22.1325 15.8486 22.1507 16.124 21.9292C16.4247 21.6873 16.7977 21.317 17.4204 20.6943L25.8074 12.3074L28.1936 14.6936Z" fill="currentColor" />
    <path d="M32.8496 18.0005C32.8496 9.79906 26.2019 3.15137 18.0005 3.15137C9.79906 3.15137 3.15137 9.79906 3.15137 18.0005C3.15137 26.2019 9.79906 32.8496 18.0005 32.8496C26.2019 32.8496 32.8496 26.2019 32.8496 18.0005ZM35.7764 18.0005C35.7764 27.8173 27.8173 35.7764 18.0005 35.7764C8.18363 35.7764 0.224609 27.8173 0.224609 18.0005C0.224609 8.18363 8.18363 0.224609 18.0005 0.224609C27.8173 0.224609 35.7764 8.18363 35.7764 18.0005Z" fill="currentColor" />
  </svg>
)

/** Regular IconCheckCircleFill artwork (circled check); its fill-only geometry is weight-independent. */
export const IconCheckCircleFillRegular = (props: IconProps) => (
  <IconCheckCircleFillArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconCheckCircleFill artwork; it matches Regular because the geometry is fill-only. */
export const IconCheckCircleFillMedium = (props: IconProps) => (
  <IconCheckCircleFillArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconWarningTriangleOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <path d="M6.87 2.6a1.33 1.33 0 0 1 2.26 0l5.34 9.33A1.33 1.33 0 0 1 13.33 14H2.67a1.33 1.33 0 0 1-1.14-2.07Z" stroke="currentColor" />
    <path d="M8 6v3m0 2.33h.01" stroke="currentColor" />
  </svg>
)

/** Regular rounded warning triangle with an exclamation mark. */
export const IconWarningTriangleOutlineRegular = (props: IconProps) => (
  <IconWarningTriangleOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium rounded warning triangle with an exclamation mark. */
export const IconWarningTriangleOutlineMedium = (props: IconProps) => (
  <IconWarningTriangleOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconUserOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M8 8.25C9.51878 8.25 10.75 7.01878 10.75 5.5C10.75 3.98122 9.51878 2.75 8 2.75C6.48122 2.75 5.25 3.98122 5.25 5.5C5.25 7.01878 6.48122 8.25 8 8.25Z" stroke="currentColor" />
    <path d="M2.5 14.5C2.5 11.5 5.25 10.25 8 10.25C10.75 10.25 13.5 11.5 13.5 14.5" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconUserOutline artwork. */
export const IconUserOutlineRegular = (props: IconProps) => (
  <IconUserOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconUserOutline artwork with a 1.3px stroke. */
export const IconUserOutlineMedium = (props: IconProps) => (
  <IconUserOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconUsersOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M6 8.25C7.51878 8.25 8.75 7.01878 8.75 5.5C8.75 3.98122 7.51878 2.75 6 2.75C4.48122 2.75 3.25 3.98122 3.25 5.5C3.25 7.01878 4.48122 8.25 6 8.25Z" stroke="currentColor" />
    <path d="M1 14.5C1 11.5 3.5 10.25 6 10.25C8.5 10.25 11 11.5 11 14.5" stroke="currentColor" />
    <path d="M10.5 2.9C11.65 3.35 12.45 4.35 12.45 5.5C12.45 6.65 11.65 7.65 10.5 8.1" stroke="currentColor" />
    <path d="M12.4 10.6C13.9 11.3 15 12.6 15 14.5" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconUsersOutline artwork: a front person with a second person behind. */
export const IconUsersOutlineRegular = (props: IconProps) => (
  <IconUsersOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconUsersOutline artwork with a 1.3px stroke. */
export const IconUsersOutlineMedium = (props: IconProps) => (
  <IconUsersOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconPaperPlaneOutlineArtwork = ({ size = 14, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M4.74024 9.11029L1.82882 7.79865C1.75022 7.76323 1.75026 7.65161 1.82889 7.61626L12.9665 2.60943C13.0354 2.57846 13.1125 2.63213 13.1073 2.70749L12.3914 13.1388C12.3864 13.2117 12.3073 13.2548 12.2433 13.2194L6.12677 9.83657" stroke="currentColor" />
    <path d="M8.44336 11.0825L6.2832 13.2843C6.22048 13.3482 6.11182 13.3038 6.11182 13.2143V9.86772C6.11182 9.84165 6.122 9.8166 6.1402 9.79793L12.972 2.78748" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconPaperPlaneOutline artwork. */
export const IconPaperPlaneOutlineRegular = (props: IconProps) => (
  <IconPaperPlaneOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconPaperPlaneOutline artwork with a 1.3px stroke. */
export const IconPaperPlaneOutlineMedium = (props: IconProps) => (
  <IconPaperPlaneOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconStopFillArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M12.5 2.5H3.5C2.94772 2.5 2.5 2.94772 2.5 3.5V12.5C2.5 13.0523 2.94772 13.5 3.5 13.5H12.5C13.0523 13.5 13.5 13.0523 13.5 12.5V3.5C13.5 2.94772 13.0523 2.5 12.5 2.5Z" fill="currentColor" />
  </svg>
)

/** Regular IconStopFill artwork; its fill-only geometry is weight-independent. */
export const IconStopFillRegular = (props: IconProps) => (
  <IconStopFillArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconStopFill artwork; it matches Regular because the geometry is fill-only. */
export const IconStopFillMedium = (props: IconProps) => (
  <IconStopFillArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconPaperclipOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M12.75 4.5V9.5C12.75 10.7598 12.2496 11.968 11.3588 12.8588C10.468 13.7496 9.25978 14.25 8 14.25C6.74022 14.25 5.53204 13.7496 4.64124 12.8588C3.75045 11.968 3.25 10.7598 3.25 9.5V5C3.25 4.13805 3.59241 3.3114 4.2019 2.7019C4.8114 2.09241 5.63805 1.75 6.5 1.75C7.36195 1.75 8.1886 2.09241 8.7981 2.7019C9.40759 3.3114 9.75 4.13805 9.75 5V9.5C9.75 9.96413 9.56563 10.4092 9.23744 10.7374C8.90925 11.0656 8.46413 11.25 8 11.25C7.53587 11.25 7.09075 11.0656 6.76256 10.7374C6.43437 10.4092 6.25 9.96413 6.25 9.5V5.5" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconPaperclipOutline artwork. */
export const IconPaperclipOutlineRegular = (props: IconProps) => (
  <IconPaperclipOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconPaperclipOutline artwork with a 1.3px stroke. */
export const IconPaperclipOutlineMedium = (props: IconProps) => (
  <IconPaperclipOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconLoadingOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M12.596 12.596C11.687 13.5049 10.5288 14.1239 9.26798 14.3747C8.00716 14.6255 6.70028 14.4968 5.51261 14.0048C4.32494 13.5129 3.30981 12.6798 2.59557 11.611C1.88134 10.5421 1.50008 9.2855 1.5 7.99998C1.50008 6.71446 1.88134 5.45783 2.59557 4.38898C3.30981 3.32013 4.32494 2.48707 5.51261 1.99513C6.70028 1.50319 8.00716 1.37447 9.26798 1.62524C10.5288 1.87602 11.687 2.49502 12.596 3.40398" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconLoadingOutline artwork. */
export const IconLoadingOutlineRegular = (props: IconProps) => (
  <IconLoadingOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconLoadingOutline artwork with a 1.3px stroke. */
export const IconLoadingOutlineMedium = (props: IconProps) => (
  <IconLoadingOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconDownloadOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M8 1.95317V10.0469" stroke="currentColor" />
    <path d="M4.25 6.29688L8 10.0469L11.75 6.29688" stroke="currentColor" />
    <path d="M1.5 10.0469V13.158C1.5 13.3937 1.60536 13.6198 1.79289 13.7865C1.98043 13.9532 2.23478 14.0469 2.5 14.0469H13.5C13.7652 14.0469 14.0196 13.9532 14.2071 13.7865C14.3946 13.6198 14.5 13.3937 14.5 13.158V10.0469" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconDownloadOutline artwork. */
export const IconDownloadOutlineRegular = (props: IconProps) => (
  <IconDownloadOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconDownloadOutline artwork with a 1.3px stroke. */
export const IconDownloadOutlineMedium = (props: IconProps) => (
  <IconDownloadOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconPlayOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z" stroke="currentColor" />
    <path d="M10.3329 7.91346C10.3996 7.95195 10.3996 8.04818 10.3329 8.08667L6.78304 10.1362C6.71638 10.1747 6.63304 10.1266 6.63304 10.0496L6.63304 5.95055C6.63304 5.87357 6.71638 5.82546 6.78304 5.86395L10.3329 7.91346Z" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconPlayOutline artwork. */
export const IconPlayOutlineRegular = (props: IconProps) => (
  <IconPlayOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconPlayOutline artwork with a 1.3px stroke. */
export const IconPlayOutlineMedium = (props: IconProps) => (
  <IconPlayOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconPauseOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z" stroke="currentColor" />
    <path d="M6.5 5V11" stroke="currentColor" />
    <path d="M9.5 5V11" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconPauseOutline artwork. */
export const IconPauseOutlineRegular = (props: IconProps) => (
  <IconPauseOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconPauseOutline artwork with a 1.3px stroke. */
export const IconPauseOutlineMedium = (props: IconProps) => (
  <IconPauseOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconFullscreenOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M2.33154 9.40576V13.1685C2.3318 13.4444 2.55556 13.6685 2.83154 13.6685H6.49463V14.6685H2.83154C2.00328 14.6685 1.3318 13.9967 1.33154 13.1685V9.40576H2.33154ZM13.1685 1.33154C13.9964 1.33199 14.6683 2.00352 14.6685 2.83154V6.40576H13.6685V2.83154C13.6683 2.5558 13.4441 2.33199 13.1685 2.33154H9.49463V1.33154H13.1685Z" fill="currentColor" />
    <path d="M9.4292 6.57077L13.914 2.08594" stroke="currentColor" />
    <path d="M6.57077 9.4292L2.08594 13.914" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconFullscreenOutline artwork. */
export const IconFullscreenOutlineRegular = (props: IconProps) => (
  <IconFullscreenOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconFullscreenOutline artwork with a 1.3px stroke. */
export const IconFullscreenOutlineMedium = (props: IconProps) => (
  <IconFullscreenOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconCodeOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M6.27612 1.5L4.52612 14.5" stroke="currentColor" />
    <path d="M11.4739 1.5L9.72388 14.5" stroke="currentColor" />
    <path d="M2.39868 5.5H14.0681" stroke="currentColor" />
    <path d="M1.93188 10.5H13.6013" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconCodeOutline artwork. */
export const IconCodeOutlineRegular = (props: IconProps) => (
  <IconCodeOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconCodeOutline artwork with a 1.3px stroke. */
export const IconCodeOutlineMedium = (props: IconProps) => (
  <IconCodeOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconCordisPluginOutlineArtwork = ({ size = 14, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M3.16143 6.59068L1.75205 8.00006L3.10619 9.35419L2.39908 10.0613L0.832948 8.49517C0.559581 8.2218 0.559582 7.77831 0.832948 7.50494L2.45432 5.88357L3.16143 6.59068ZM8.49511 15.1671C8.22176 15.4405 7.77826 15.4404 7.50489 15.1671L5.93461 13.5968L6.64172 12.8897L8 14.248L9.40938 12.8386L10.1165 13.5457L8.49511 15.1671ZM15.1671 7.50494C15.4403 7.7782 15.4401 8.22179 15.1671 8.49517L13.652 10.0102L12.9449 9.30309L14.248 8.00006L12.8897 6.64178L13.5968 5.93467L15.1671 7.50494ZM9.35414 3.10624L8 1.7521L6.69696 3.05514L5.98986 2.34803L7.50489 0.833003C7.77828 0.559981 8.22186 0.559752 8.49511 0.833003L10.0612 2.39913L9.35414 3.10624Z" fill="currentColor" />
    <circle cx="8" cy="8" r="1.76221" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconCordisPluginOutline artwork. */
export const IconCordisPluginOutlineRegular = (props: IconProps) => (
  <IconCordisPluginOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconCordisPluginOutline artwork with a 1.3px stroke. */
export const IconCordisPluginOutlineMedium = (props: IconProps) => (
  <IconCordisPluginOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconApiOutlineArtwork = ({ size = 14, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M3 4L7 8L3 12" stroke="currentColor" />
    <path d="M9 12H13" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconApiOutline artwork. */
export const IconApiOutlineRegular = (props: IconProps) => (
  <IconApiOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconApiOutline artwork with a 1.3px stroke. */
export const IconApiOutlineMedium = (props: IconProps) => (
  <IconApiOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconPersonalizationOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M3.25 7.16357C3.20417 7.32247 3.17778 7.48993 3.17773 7.66357C3.17773 7.83698 3.20336 8.00486 3.24902 8.16357H1.85742V7.16357H3.25ZM14.1426 8.16357H6.71484C6.76052 8.00485 6.78613 7.837 6.78613 7.66357C6.78609 7.48991 6.75971 7.32249 6.71387 7.16357H14.1426V8.16357Z" fill="currentColor" />
    <path d="M9.1377 11.9092C9.08596 12.0666 9.05668 12.2344 9.05664 12.4092C9.05664 12.5838 9.08606 12.7518 9.1377 12.9092H1.85742V11.9092H9.1377ZM14.1426 12.9092H12.1816C12.2332 12.7519 12.2617 12.5838 12.2617 12.4092C12.2617 12.2345 12.2333 12.0666 12.1816 11.9092H14.1426V12.9092Z" fill="currentColor" />
    <path d="M9.1123 3.09106C9.06138 3.24865 9.03324 3.41653 9.0332 3.59106C9.0332 3.76549 9.06148 3.93355 9.1123 4.09106H1.85742V3.09106H9.1123ZM14.1426 4.09106H12.207C12.2578 3.93358 12.2861 3.76545 12.2861 3.59106C12.2861 3.41657 12.2579 3.24862 12.207 3.09106H14.1426V4.09106Z" fill="currentColor" />
    <circle cx="4.97065" cy="7.66401" r="1.35151" stroke="currentColor" />
    <circle cx="10.6596" cy="12.4091" r="1.35151" stroke="currentColor" />
    <circle cx="10.6596" cy="3.59101" r="1.35151" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconPersonalizationOutline artwork. */
export const IconPersonalizationOutlineRegular = (props: IconProps) => (
  <IconPersonalizationOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconPersonalizationOutline artwork with a 1.3px stroke. */
export const IconPersonalizationOutlineMedium = (props: IconProps) => (
  <IconPersonalizationOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconProjectAddOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M5.54492 2.06738C5.91034 2.06754 6.26318 2.20149 6.53711 2.44336L7.94043 3.68164V4.7998C7.71462 4.74105 7.50367 4.63139 7.32617 4.47461L5.87598 3.19238C5.78477 3.11185 5.66658 3.06754 5.54492 3.06738H2.94922C2.67322 3.06738 2.44946 3.29145 2.44922 3.56738V12.4326C2.44927 12.7087 2.67311 12.9326 2.94922 12.9326H12.9326C13.2086 12.9325 13.4326 12.7086 13.4326 12.4326V8.53613H14.4326V12.4326C14.4326 13.2609 13.7609 13.9325 12.9326 13.9326H2.94922C2.12083 13.9326 1.44927 13.261 1.44922 12.4326V3.56738C1.44946 2.73916 2.12094 2.06738 2.94922 2.06738H5.54492Z" fill="currentColor" />
    <path d="M9.75977 4.50208H14.5509" stroke="currentColor" />
    <path d="M12.1492 6.89758L12.1492 2.10642" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconProjectAddOutline artwork. */
export const IconProjectAddOutlineRegular = (props: IconProps) => (
  <IconProjectAddOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconProjectAddOutline artwork with a 1.3px stroke. */
export const IconProjectAddOutlineMedium = (props: IconProps) => (
  <IconProjectAddOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconFolderOpenOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M12.3994 13.5986H2.04956C1.49728 13.5986 1.04956 13.1509 1.04956 12.5986V3.40137C1.04956 2.84908 1.49728 2.40137 2.04956 2.40137H4.76632C5.01016 2.40137 5.24561 2.49046 5.42836 2.6519L6.94088 3.98799C7.12364 4.14943 7.35908 4.23852 7.60293 4.23852H12.3994C12.9517 4.23852 13.3994 4.68624 13.3994 5.23852V7.16991" stroke="currentColor" />
    <path d="M2.55911 7.93683C2.67584 7.49906 3.07229 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55911 7.93683Z" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconFolderOpenOutline artwork. */
export const IconFolderOpenOutlineRegular = (props: IconProps) => (
  <IconFolderOpenOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconFolderOpenOutline artwork with a 1.3px stroke. */
export const IconFolderOpenOutlineMedium = (props: IconProps) => (
  <IconFolderOpenOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconFolderOpenArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z" fill="currentColor" opacity="0.16" />
    <path d="M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z" fill="currentColor" />
    <path d="M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z" fill="currentColor" />
  </svg>
)

/** Regular IconFolderOpen artwork; its fill-only geometry is weight-independent. */
export const IconFolderOpenRegular = (props: IconProps) => (
  <IconFolderOpenArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconFolderOpen artwork; it matches Regular because the geometry is fill-only. */
export const IconFolderOpenMedium = (props: IconProps) => (
  <IconFolderOpenArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

/** Regular one-pixel IconFolderClose artwork. */
export const IconFolderCloseRegular = (props: IconProps) => (
  <FolderCloseArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconFolderClose artwork with a 1.3px stroke. */
export const IconFolderCloseMedium = (props: IconProps) => (
  <FolderCloseArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconTreeCornerArtwork = ({ size = 10, className, strokeWidth }: WeightedIconProps) => (
  <svg width={(size * 8) / 10} height={size} className={className} viewBox="0 0 9 11" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M0.5 0V7C0.5 7.79565 0.81607 8.55871 1.37868 9.12132C1.94129 9.68393 2.70435 10 3.5 10H8.5" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconTreeCorner artwork. */
export const IconTreeCornerRegular = (props: IconProps) => (
  <IconTreeCornerArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconTreeCorner artwork with a 1.3px stroke. */
export const IconTreeCornerMedium = (props: IconProps) => (
  <IconTreeCornerArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconLightOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M8.00007 11.8117C10.1052 11.8117 11.8117 10.1052 11.8117 8.00007C11.8117 5.89499 10.1052 4.18848 8.00007 4.18848C5.89499 4.18848 4.18848 5.89499 4.18848 8.00007C4.18848 10.1052 5.89499 11.8117 8.00007 11.8117Z" stroke="currentColor" />
    <path d="M13.3899 8H15.1499" stroke="currentColor" />
    <path d="M11.8115 11.8115L13.0556 13.0556" stroke="currentColor" />
    <path d="M8 13.3901V15.1501" stroke="currentColor" />
    <path d="M4.18868 11.8115L2.94458 13.0556" stroke="currentColor" />
    <path d="M2.6101 8H0.850098" stroke="currentColor" />
    <path d="M4.18868 4.18856L2.94458 2.94446" stroke="currentColor" />
    <path d="M8 2.6101V0.850098" stroke="currentColor" />
    <path d="M11.8115 4.18856L13.0556 2.94446" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconLightOutline artwork. */
export const IconLightOutlineRegular = (props: IconProps) => (
  <IconLightOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconLightOutline artwork with a 1.3px stroke. */
export const IconLightOutlineMedium = (props: IconProps) => (
  <IconLightOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconDarkOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M14.1127 8.70663C14.2576 8.60602 14.4627 8.71355 14.4386 8.88834C14.2901 9.96567 13.8731 10.9912 13.2229 11.8692C12.479 12.8735 11.4613 13.6421 10.2917 14.0829C9.1222 14.5236 7.85038 14.6179 6.62865 14.3543C5.40692 14.0907 4.28709 13.4805 3.40332 12.5967C2.51955 11.7129 1.90931 10.5931 1.64572 9.37135C1.38212 8.14962 1.47635 6.87779 1.91711 5.70825C2.35787 4.5387 3.12647 3.52103 4.13083 2.77714C5.00878 2.12689 6.03433 1.70994 7.11166 1.5614C7.28645 1.5373 7.39397 1.74238 7.29337 1.88734C6.68703 2.76099 6.37885 3.81241 6.42313 4.88345C6.47392 6.11194 6.98471 7.27645 7.85413 8.14587C8.72355 9.01529 9.88805 9.52608 11.1166 9.57687C12.1876 9.62114 13.239 9.31296 14.1127 8.70663Z" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconDarkOutline artwork. */
export const IconDarkOutlineRegular = (props: IconProps) => (
  <IconDarkOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconDarkOutline artwork with a 1.3px stroke. */
export const IconDarkOutlineMedium = (props: IconProps) => (
  <IconDarkOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconFollowsystemOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M13.5 2.5H2.5C1.94772 2.5 1.5 2.94772 1.5 3.5V11.5C1.5 12.0523 1.94772 12.5 2.5 12.5H13.5C14.0523 12.5 14.5 12.0523 14.5 11.5V3.5C14.5 2.94772 14.0523 2.5 13.5 2.5Z" stroke="currentColor" />
    <path d="M5 14.5H11" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconFollowsystemOutline artwork. */
export const IconFollowsystemOutlineRegular = (props: IconProps) => (
  <IconFollowsystemOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconFollowsystemOutline artwork with a 1.3px stroke. */
export const IconFollowsystemOutlineMedium = (props: IconProps) => (
  <IconFollowsystemOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconDataOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M7.8667 0.349609C8.96906 0.349634 10.0601 0.481272 11.0317 0.735352C11.9973 0.987845 12.8453 1.362 13.4644 1.84766C14.0744 2.32629 14.507 2.95539 14.5161 3.69336H14.5171V8.53516C14.0843 8.32076 13.6108 8.17679 13.1108 8.11816C13.1831 7.96848 13.2162 7.82856 13.2163 7.70312V5.76758C12.6269 6.16618 11.8739 6.47995 11.0317 6.7002C10.0602 6.95423 8.96896 7.08494 7.8667 7.08496C6.76461 7.08493 5.67411 6.95415 4.70264 6.7002C3.85994 6.48006 3.10694 6.1662 2.51709 5.76758V7.70312L2.521 7.78418C2.56374 8.19554 2.93361 8.74414 3.91357 9.23145C4.9281 9.73585 6.35004 10.0371 7.8667 10.0371C8.26373 10.0371 8.6543 10.0141 9.03271 9.97461C8.75596 10.3799 8.54664 10.8349 8.42041 11.3232C8.23666 11.3313 8.0518 11.3369 7.8667 11.3369C6.20108 11.3369 4.57025 11.01 3.33447 10.3955C3.04163 10.2499 2.76658 10.0836 2.51709 9.90039V11.6738C2.51728 12.1379 2.88589 12.7556 3.92236 13.292C4.93457 13.8157 6.35342 14.1289 7.8667 14.1289C8.12318 14.1289 8.37694 14.1161 8.62646 14.0986C8.82021 14.5535 9.08999 14.9682 9.41943 15.3271C8.91285 15.3934 8.39149 15.4287 7.8667 15.4287C6.19761 15.4287 4.56379 15.0869 3.32568 14.4463C2.11244 13.8185 1.21649 12.8562 1.21631 11.6738V3.76367C1.21595 3.74853 1.21438 3.733 1.21436 3.71777C1.21436 2.96917 1.65103 2.33053 2.26807 1.84668C2.88747 1.36112 3.73675 0.987685 4.70264 0.735352C5.67413 0.481376 6.76457 0.349636 7.8667 0.349609ZM7.8667 1.65039C6.86269 1.65042 5.88326 1.77028 5.03076 1.99316C4.17183 2.2176 3.50421 2.52956 3.06982 2.87012C2.65043 3.19909 2.52622 3.48898 2.51709 3.69336V3.74414C2.52719 3.94845 2.65185 4.23772 3.06982 4.56543C3.50425 4.90601 4.17172 5.21795 5.03076 5.44238C5.88326 5.66527 6.8627 5.78513 7.8667 5.78516C8.8707 5.78513 9.85015 5.66525 10.7026 5.44238C11.5611 5.21787 12.2286 4.9049 12.6626 4.56445C13.0982 4.22252 13.2163 3.9231 13.2163 3.71777L13.2104 3.63574C13.1818 3.43623 13.044 3.16941 12.6626 2.87012C12.2286 2.52957 11.5614 2.21773 10.7026 1.99316C9.85009 1.77025 8.8708 1.65041 7.8667 1.65039Z" fill="currentColor" />
    <path d="M12.8936 10.0361L13.2061 10.5566C13.2296 10.5959 13.2651 10.6562 13.3027 10.707C13.3469 10.7666 13.4148 10.8431 13.5195 10.9023C13.6244 10.9617 13.725 10.9801 13.7988 10.9873C13.8619 10.9934 13.9318 10.9932 13.9775 10.9932H14.6162L14.8896 11.4502L14.5947 11.9443C14.5698 11.9859 14.5312 12.0483 14.5029 12.1084C14.4781 12.1611 14.4514 12.2312 14.4395 12.3164L14.4326 12.4072L14.4395 12.4971C14.4514 12.5825 14.4781 12.6532 14.5029 12.7061C14.5312 12.7661 14.5689 12.8287 14.5938 12.8701L14.8896 13.3633L14.6162 13.8213H13.9775C13.9318 13.8213 13.8619 13.821 13.7988 13.8271C13.7433 13.8326 13.6728 13.8442 13.5967 13.875L13.5195 13.9121C13.4148 13.9714 13.3469 14.0478 13.3027 14.1074C13.265 14.1583 13.2296 14.2186 13.2061 14.2578L12.8936 14.7783H12.3115L11.999 14.2578C11.9755 14.2186 11.9401 14.1583 11.9023 14.1074C11.8693 14.0628 11.823 14.0083 11.7578 13.959L11.6855 13.9121L11.6074 13.875C11.5316 13.8445 11.4615 13.8325 11.4062 13.8271C11.3432 13.821 11.2733 13.8213 11.2275 13.8213H10.5889L10.3135 13.3633L10.6104 12.8701C10.6352 12.8287 10.6739 12.7661 10.7021 12.7061C10.7352 12.6357 10.7724 12.534 10.7725 12.4072C10.7724 12.2804 10.7352 12.1788 10.7021 12.1084C10.6739 12.0483 10.6353 11.9859 10.6104 11.9443L10.3135 11.4502L10.5889 10.9932H11.2275C11.2733 10.9932 11.3432 10.9934 11.4062 10.9873C11.4801 10.9801 11.5808 10.9616 11.6855 10.9023C11.7903 10.843 11.8582 10.7666 11.9023 10.707C11.94 10.6562 11.9755 10.5959 11.999 10.5566L12.3115 10.0361H12.8936Z" stroke="currentColor" strokeMiterlimit="10" />
  </svg>
)

/** Regular one-pixel IconDataOutline artwork. */
export const IconDataOutlineRegular = (props: IconProps) => (
  <IconDataOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconDataOutline artwork with a 1.3px stroke. */
export const IconDataOutlineMedium = (props: IconProps) => (
  <IconDataOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconDatabaseOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M13.1967 5.1869C13.7232 4.77378 14.0003 4.30517 14.0001 3.82819C14.0003 3.3512 13.7232 2.88259 13.1967 2.46947C12.6702 2.05635 11.9128 1.71328 11.0006 1.47475C10.0885 1.23621 9.05371 1.11062 8.00039 1.1106C6.94707 1.11057 5.9123 1.23612 5.00009 1.47461C4.08742 1.71301 3.32948 2.05604 2.80249 2.46919C2.2755 2.88235 1.99805 3.35106 1.99805 3.82819C1.99805 4.30531 2.2755 4.77402 2.80249 5.18718C3.32948 5.60033 4.08742 5.94336 5.00009 6.18176C5.9123 6.42025 6.94707 6.5458 8.00039 6.54578C9.05371 6.54575 10.0885 6.42016 11.0006 6.18163C11.9128 5.94309 12.6702 5.60002 13.1967 5.1869Z" stroke="currentColor" />
    <path d="M2 3.80371V11.7848" stroke="currentColor" />
    <path d="M14 3.80371V11.7848" stroke="currentColor" />
    <path d="M2 7.81396C2 8.60524 2.63214 9.36411 3.75736 9.92363C4.88258 10.4832 6.4087 10.7975 8 10.7975C9.5913 10.7975 11.1174 10.4832 12.2426 9.92363C13.3679 9.36411 14 8.60524 14 7.81396" stroke="currentColor" />
    <path d="M2 11.7847C2 12.6081 2.63214 13.3977 3.75736 13.98C4.88258 14.5622 6.4087 14.8893 8 14.8893C9.5913 14.8893 11.1174 14.5622 12.2426 13.98C13.3679 13.3977 14 12.6081 14 11.7847" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconDatabaseOutline artwork. */
export const IconDatabaseOutlineRegular = (props: IconProps) => (
  <IconDatabaseOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconDatabaseOutline artwork with a 1.3px stroke. */
export const IconDatabaseOutlineMedium = (props: IconProps) => (
  <IconDatabaseOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconClockOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M8 14C11.3137 14 14 11.3137 14 8C14 4.68629 11.3137 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14Z" stroke="currentColor" />
    <path d="M8 4.31V8.46L11 10.08" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconClockOutline artwork. */
export const IconClockOutlineRegular = (props: IconProps) => (
  <IconClockOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconClockOutline artwork with a 1.3px stroke. */
export const IconClockOutlineMedium = (props: IconProps) => (
  <IconClockOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconGaugeOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M3.4041 13.096C2.49514 12.187 1.87614 11.0288 1.62537 9.76798C1.37459 8.50716 1.50331 7.20028 1.99525 6.01261C2.48719 4.82494 3.32025 3.80981 4.3891 3.09557C5.45795 2.38134 6.71458 2.00008 8.0001 2C9.28563 2.00008 10.5423 2.38134 11.6111 3.09557C12.68 3.80981 13.513 4.82494 14.005 6.01261C14.4969 7.20028 14.6256 8.50716 14.3748 9.76798C14.1241 11.0288 13.5051 12.187 12.5961 13.096" stroke="currentColor" />
    <path d="M8 8.49994L11.6114 4.88855" stroke="currentColor" />
    <path d="M8 9.75C8.69036 9.75 9.25 9.19036 9.25 8.5C9.25 7.80964 8.69036 7.25 8 7.25C7.30964 7.25 6.75 7.80964 6.75 8.5C6.75 9.19036 7.30964 9.75 8 9.75Z" fill="currentColor" />
  </svg>
)

/** Regular one-pixel IconGaugeOutline artwork. */
export const IconGaugeOutlineRegular = (props: IconProps) => (
  <IconGaugeOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconGaugeOutline artwork with a 1.3px stroke. */
export const IconGaugeOutlineMedium = (props: IconProps) => (
  <IconGaugeOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconSendOutlineArtwork = ({ size = 14, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M6.97211 1.94476C7.55785 1.35914 8.50767 1.35919 9.09343 1.94476L13.921 6.77228L13.2138 7.47939L8.38632 2.65187C8.19108 2.45682 7.87443 2.45677 7.67922 2.65187L2.74397 7.58711L2.03687 6.88L6.97211 1.94476Z" fill="currentColor" />
    <path d="M7.97571 14.5732L8.02421 2.34139" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconSendOutline artwork. */
export const IconSendOutlineRegular = (props: IconProps) => (
  <IconSendOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconSendOutline artwork with a 1.3px stroke. */
export const IconSendOutlineMedium = (props: IconProps) => (
  <IconSendOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconQueueOutlineArtwork = ({ size = 14, ...rest }: WeightedIconProps) => (
  <ChatLinesOutlineArtwork size={size} {...rest} />
)

/** Regular one-pixel IconQueueOutline artwork. */
export const IconQueueOutlineRegular = (props: IconProps) => (
  <IconQueueOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconQueueOutline artwork with a 1.3px stroke. */
export const IconQueueOutlineMedium = (props: IconProps) => (
  <IconQueueOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconChecklistOutlineArtwork = ({ size = 14, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M3.75 6.25C4.7165 6.25 5.5 5.4665 5.5 4.5C5.5 3.5335 4.7165 2.75 3.75 2.75C2.7835 2.75 2 3.5335 2 4.5C2 5.4665 2.7835 6.25 3.75 6.25Z" stroke="currentColor" />
    <path d="M7.5 4.5H13.5" stroke="currentColor" />
    <path d="M3.75 13.25C4.7165 13.25 5.5 12.4665 5.5 11.5C5.5 10.5335 4.7165 9.75 3.75 9.75C2.7835 9.75 2 10.5335 2 11.5C2 12.4665 2.7835 13.25 3.75 13.25Z" stroke="currentColor" />
    <path d="M7.5 11.5H13.5" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconChecklistOutline artwork. */
export const IconChecklistOutlineRegular = (props: IconProps) => (
  <IconChecklistOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconChecklistOutline artwork with a 1.3px stroke. */
export const IconChecklistOutlineMedium = (props: IconProps) => (
  <IconChecklistOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconListPenOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M4.9375 5.90295H11.0625" stroke="currentColor" />
    <path d="M4.9375 9.02991H8.27841" stroke="currentColor" />
    <path d="M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V7.61328L13 8.68164V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H8.32812L7.39258 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5Z" fill="currentColor" />
    <path d="M8.97212 14.3693C9.17511 14.5723 9.37811 14.7753 9.5811 14.9783C9.67012 14.8953 9.75914 14.8123 9.84815 14.7293C11.4505 13.2352 13.0528 11.7411 14.6551 10.247C14.7441 10.164 14.8331 10.081 14.9221 9.99803C14.5989 9.6748 14.2756 9.35157 13.9524 9.02834C13.8694 9.11736 13.7864 9.20637 13.7034 9.29539C12.2093 10.8977 10.7152 12.5 9.22113 14.1023C9.13813 14.1913 9.05513 14.2803 8.97212 14.3693Z" fill="currentColor" />
    <path d="M11.6323 13.7841C11.6323 14.0395 11.6323 14.295 11.6323 14.5504C11.6812 14.5523 11.7301 14.5543 11.779 14.5562C12.659 14.5913 13.539 14.6263 14.419 14.6614C14.4679 14.6633 14.5168 14.6653 14.5657 14.6672C14.5657 14.3339 14.5657 14.0006 14.5657 13.6672C14.5168 13.6692 14.4679 13.6711 14.419 13.6731C13.539 13.7081 12.659 13.7432 11.779 13.7783C11.7301 13.7802 11.6812 13.7821 11.6323 13.7841Z" fill="currentColor" />
  </svg>
)

/** Regular one-pixel IconListPenOutline artwork. */
export const IconListPenOutlineRegular = (props: IconProps) => (
  <IconListPenOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconListPenOutline artwork with a 1.3px stroke. */
export const IconListPenOutlineMedium = (props: IconProps) => (
  <IconListPenOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconGoalOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5" stroke="currentColor" />
    <path d="M11.5 8C11.5001 8.69227 11.2948 9.36901 10.9102 9.94463C10.5257 10.5202 9.97901 10.9689 9.33944 11.2338C8.69986 11.4987 7.99609 11.5681 7.31712 11.433C6.63816 11.2979 6.01449 10.9645 5.52501 10.475C5.03548 9.98552 4.70209 9.36185 4.56702 8.68289C4.43195 8.00392 4.50127 7.30015 4.76619 6.66057C5.03112 6.021 5.47976 5.47436 6.05538 5.08978C6.631 4.70519 7.30774 4.49995 8.00001 4.5" stroke="currentColor" />
    <path d="M8.00024 7.99976L11.2 4.80005" stroke="currentColor" />
    <path d="M12.4719 5.62245C12.4246 5.66972 12.3569 5.69025 12.2913 5.67715L10.7814 5.37555C10.7022 5.35972 10.6402 5.29781 10.6244 5.2186L10.3228 3.70866C10.3097 3.6431 10.3302 3.57533 10.3775 3.52806L12.1826 1.723C12.2863 1.61929 12.4627 1.65879 12.5122 1.79684L12.9271 2.95225C12.9472 3.00847 12.9915 3.05272 13.0477 3.07291L14.2031 3.48774C14.3412 3.5373 14.3807 3.71368 14.277 3.81739L12.4719 5.62245Z" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconGoalOutline artwork. */
export const IconGoalOutlineRegular = (props: IconProps) => (
  <IconGoalOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconGoalOutline artwork with a 1.3px stroke. */
export const IconGoalOutlineMedium = (props: IconProps) => (
  <IconGoalOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconSparkleArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M5.875 3C5.875 6.33333 7.54167 8 10.875 8C7.54167 8 5.875 9.66667 5.875 13C5.875 9.66667 4.20833 8 0.875 8C4.20833 8 5.875 6.33333 5.875 3Z" stroke="currentColor" />
    <path d="M12.375 1.55823C12.375 3.39156 13.2917 4.30823 15.125 4.30823C13.2917 4.30823 12.375 5.22489 12.375 7.05823C12.375 5.22489 11.4583 4.30823 9.625 4.30823C11.4583 4.30823 12.375 3.39156 12.375 1.55823Z" stroke="currentColor" />
    <path d="M12.375 10.4418C12.375 11.7751 13.0417 12.4418 14.375 12.4418C13.0417 12.4418 12.375 13.1084 12.375 14.4418C12.375 13.1084 11.7083 12.4418 10.375 12.4418C11.7083 12.4418 12.375 11.7751 12.375 10.4418Z" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconSparkle artwork. */
export const IconSparkleRegular = (props: IconProps) => (
  <IconSparkleArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconSparkle artwork with a 1.3px stroke. */
export const IconSparkleMedium = (props: IconProps) => (
  <IconSparkleArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

/** Regular one-pixel IconInspectOutline artwork. */
export const IconInspectOutlineRegular = (props: IconProps) => (
  <CodeBracketsArtwork {...props} size={props.size ?? 12} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconInspectOutline artwork with a 1.3px stroke. */
export const IconInspectOutlineMedium = (props: IconProps) => (
  <CodeBracketsArtwork {...props} size={props.size ?? 12} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconSkillOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 17 17" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M4.57788 5.77124H10.7029" stroke="currentColor" />
    <path d="M4.57788 8.89819H7.91879" stroke="currentColor" />
    <path d="M12.1404 1.19446C12.9442 1.19446 13.6404 1.81999 13.6404 2.64465V8.89856H12.6404V2.64465C12.6404 2.42015 12.4411 2.19446 12.1404 2.19446H3.14038C2.83968 2.19446 2.64038 2.42015 2.64038 2.64465V13.0929C2.64082 13.3172 2.84001 13.5421 3.14038 13.5421H8.88159V14.5421H3.14038C2.33675 14.5421 1.6408 13.9172 1.64038 13.0929V2.64465C1.64038 1.81999 2.33651 1.19446 3.14038 1.19446H12.1404Z" fill="currentColor" />
    <path d="M12.0051 15.1056C12.0051 13.6395 10.8166 12.451 9.35059 12.451C10.8166 12.451 12.0051 11.2626 12.0051 9.79651C12.0051 11.2626 13.1936 12.451 14.6597 12.451C13.1936 12.451 12.0051 13.6395 12.0051 15.1056Z" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconSkillOutline artwork. */
export const IconSkillOutlineRegular = (props: IconProps) => (
  <IconSkillOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconSkillOutline artwork with a 1.3px stroke. */
export const IconSkillOutlineMedium = (props: IconProps) => (
  <IconSkillOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconQuestionOutlineArtwork = ({ size = 14, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z" stroke="currentColor" />
    <path d="M5.75 6.69646C5.75 6.29865 5.88196 5.90976 6.12919 5.57899C6.37643 5.24821 6.72783 4.99041 7.13896 4.83817C7.5501 4.68593 8.0025 4.6461 8.43895 4.72371C8.87541 4.80132 9.27632 4.99289 9.59099 5.27419C9.90566 5.55549 10.12 5.91388 10.2068 6.30406C10.2936 6.69423 10.249 7.09866 10.0787 7.4662C9.90843 7.83373 9.62004 8.14787 9.25003 8.36889C9.19476 8.4019 9.13803 8.43262 9.08004 8.46099C8.52566 8.73217 8 9.20817 8 9.82532" stroke="currentColor" />
    <path d="M8 10.7416V11.7416" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconQuestionOutline artwork. */
export const IconQuestionOutlineRegular = (props: IconProps) => (
  <IconQuestionOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconQuestionOutline artwork with a 1.3px stroke. */
export const IconQuestionOutlineMedium = (props: IconProps) => (
  <IconQuestionOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconInfoOutlineArtwork = ({ size = 14, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path
      d="M12.5757 7.00012C12.5757 3.92085 10.0794 1.42463 7.00012 1.42456C3.9208 1.42456 1.42456 3.9208 1.42456 7.00012C1.42463 10.0794 3.92085 12.5757 7.00012 12.5757C10.0793 12.5756 12.5756 10.0793 12.5757 7.00012ZM13.8002 7.00012C13.8001 10.7559 10.7559 13.8001 7.00012 13.8002C3.2443 13.8002 0.199291 10.7559 0.199219 7.00012C0.199219 3.24426 3.24426 0.199219 7.00012 0.199219C10.7559 0.199291 13.8002 3.2443 13.8002 7.00012Z"
      fill="currentColor"
    />
    <path d="M7.6127 3.18921V4.55986H6.38735V3.18921H7.6127Z" fill="currentColor" />
    <path d="M7.6127 5.68921V10.8109H6.38735V5.68921H7.6127Z" fill="currentColor" />
  </svg>
)

/** Regular IconInfoOutline artwork; its fill-only geometry is weight-independent. */
export const IconInfoOutlineRegular = (props: IconProps) => (
  <IconInfoOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconInfoOutline artwork; its fill-only geometry is weight-independent. */
export const IconInfoOutlineMedium = (props: IconProps) => (
  <IconInfoOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconPluginPinwheelOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M7.84457 5.06199C11.6605 4.93876 14.7962 6.14848 14.8484 7.76397C14.8875 8.97461 13.1838 10.0696 10.7215 10.5942" stroke="currentColor" />
    <path d="M5.12742 8.07731C5.00419 4.26138 6.21391 1.12568 7.8294 1.07351C9.04004 1.03441 10.135 2.73808 10.6596 5.20037" stroke="currentColor" />
    <path d="M8.02457 10.6802C4.20865 10.8034 1.07294 9.5937 1.02077 7.97821C0.981678 6.76758 2.68535 5.67262 5.14763 5.14798" stroke="currentColor" />
    <path d="M10.7476 7.89535C10.8708 11.7113 9.66109 14.847 8.0456 14.8991C6.83496 14.9382 5.74 13.2346 5.21536 10.7723" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel plugin pinwheel artwork. */
export const IconPluginPinwheelOutlineRegular = (props: IconProps) => (
  <IconPluginPinwheelOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium plugin pinwheel artwork with a 1.3px stroke. */
export const IconPluginPinwheelOutlineMedium = (props: IconProps) => (
  <IconPluginPinwheelOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconAlarmClockOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 17 17" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M4.09372 11.9895L3.11865 14.0387" stroke="currentColor" />
    <path d="M12.1392 11.9895L13.1143 14.0387" stroke="currentColor" />
    <path d="M8.11646 4.78442V8.03442L10.6165 9.53442" stroke="currentColor" />
    <path d="M8.11646 13.4094C11.154 13.4094 13.6165 10.947 13.6165 7.90942C13.6165 4.87186 11.154 2.40942 8.11646 2.40942C5.07889 2.40942 2.61646 4.87186 2.61646 7.90942C2.61646 10.947 5.07889 13.4094 8.11646 13.4094Z" stroke="currentColor" />
    <path d="M1.75952 4.74323C2.30657 3.65639 3.12646 2.73047 4.12926 2.05542" stroke="currentColor" />
    <path d="M14.3345 4.74323C13.7874 3.65639 12.9675 2.73047 11.9647 2.05542" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconAlarmClockOutline artwork. */
export const IconAlarmClockOutlineRegular = (props: IconProps) => (
  <IconAlarmClockOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconAlarmClockOutline artwork with a 1.3px stroke. */
export const IconAlarmClockOutlineMedium = (props: IconProps) => (
  <IconAlarmClockOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconArchiveOutlineArtwork = ({ size = 20, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M13.5 2.5H2.5C1.94772 2.5 1.5 2.94772 1.5 3.5V4.5C1.5 5.05228 1.94772 5.5 2.5 5.5H13.5C14.0523 5.5 14.5 5.05228 14.5 4.5V3.5C14.5 2.94772 14.0523 2.5 13.5 2.5Z" stroke="currentColor" />
    <path d="M2.5 5.5V13.5C2.5 13.7652 2.60536 14.0196 2.79289 14.2071C2.98043 14.3946 3.23478 14.5 3.5 14.5H12.5C12.7652 14.5 13.0196 14.3946 13.2071 14.2071C13.3946 14.0196 13.5 13.7652 13.5 13.5V5.5" stroke="currentColor" />
    <path d="M6.5 9.5H9.5" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconArchiveOutline artwork. */
export const IconArchiveOutlineRegular = (props: IconProps) => (
  <IconArchiveOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconArchiveOutline artwork with a 1.3px stroke. */
export const IconArchiveOutlineMedium = (props: IconProps) => (
  <IconArchiveOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconWrapLinesOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M2.3457 3.19299H13.6541" stroke="currentColor" />
    <path d="M2.3457 7.46497H9.19332" stroke="currentColor" />
    <path d="M2.3457 11.7369H6.4849" stroke="currentColor" />
    <path d="M9.1936 7.46497H11.5183C12.6981 7.46497 13.6544 8.42132 13.6544 9.60103C13.6544 10.7808 12.6981 11.7371 11.5183 11.7371H9.1936" stroke="currentColor" />
    <path d="M10.9505 9.7677L9.12262 11.5956C9.04452 11.6737 9.04452 11.8003 9.12262 11.8784L10.9505 13.7063" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconWrapLinesOutline artwork. */
export const IconWrapLinesOutlineRegular = (props: IconProps) => (
  <IconWrapLinesOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconWrapLinesOutline artwork with a 1.3px stroke. */
export const IconWrapLinesOutlineMedium = (props: IconProps) => (
  <IconWrapLinesOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconNowrapFillArtwork = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M2 15H1V1H2V15Z" fill="currentColor" />
    <path d="M12.3535 7.64645C12.5487 7.84171 12.5487 8.15829 12.3535 8.35355L9.85352 10.8535L9.14648 10.1465L10.793 8.5H3.5V7.5H10.793L9.14648 5.85352L9.85352 5.14648L12.3535 7.64645Z" fill="currentColor" />
    <path d="M15 15H14V1H15V15Z" fill="currentColor" />
  </svg>
)

/** Regular IconNowrapFill artwork; fill-only weights render identically. */
export const IconNowrapFillRegular = (props: IconProps) => <IconNowrapFillArtwork {...props} />

/** Medium IconNowrapFill artwork; fill-only weights render identically. */
export const IconNowrapFillMedium = (props: IconProps) => <IconNowrapFillArtwork {...props} />

const IconWrapFillArtwork = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M10.9999 8C10.9999 6.89543 10.1046 6 9 6H4.5V5H9C10.6568 5 11.9999 6.34315 11.9999 8C11.9999 9.65685 10.6568 11 9 11H6.20703L6.85351 11.6465L6.14648 12.3535L4.64652 10.8536C4.45126 10.6583 4.45126 10.3417 4.64652 10.1464L6.14648 8.64648L6.85351 9.35352L6.20703 10H9C10.1046 10 10.9999 9.10457 10.9999 8Z" fill="currentColor" />
    <path d="M2 15H1V1H2V15Z" fill="currentColor" />
    <path d="M15 15H14V1H15V15Z" fill="currentColor" />
  </svg>
)

/** Regular IconWrapFill artwork; fill-only weights render identically. */
export const IconWrapFillRegular = (props: IconProps) => <IconWrapFillArtwork {...props} />

/** Medium IconWrapFill artwork; fill-only weights render identically. */
export const IconWrapFillMedium = (props: IconProps) => <IconWrapFillArtwork {...props} />

const IconCompareSplitOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M6 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H6C6.55228 14.5 7 14.0523 7 13.5V2.5C7 1.94772 6.55228 1.5 6 1.5Z" stroke="currentColor" />
    <path d="M13.5 1.5H10C9.44772 1.5 9 1.94772 9 2.5V13.5C9 14.0523 9.44772 14.5 10 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconCompareSplitOutline artwork. */
export const IconCompareSplitOutlineRegular = (props: IconProps) => (
  <IconCompareSplitOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconCompareSplitOutline artwork with a 1.3px stroke. */
export const IconCompareSplitOutlineMedium = (props: IconProps) => (
  <IconCompareSplitOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconPlanOutlineArtwork = (props: WeightedIconProps) => (
  <IconListPenOutlineArtwork {...props} size={props.size ?? 14} />
)

/** Regular one-pixel IconPlanOutline artwork. */
export const IconPlanOutlineRegular = (props: IconProps) => (
  <IconPlanOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconPlanOutline artwork with a 1.3px stroke. */
export const IconPlanOutlineMedium = (props: IconProps) => (
  <IconPlanOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconCompactOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path opacity="0.35" d="M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z" stroke="currentColor" />
    <path d="M8 1.5C8.85359 1.5 9.69883 1.66813 10.4874 1.99478C11.2761 2.32144 11.9926 2.80022 12.5962 3.40381C13.1998 4.00739 13.6786 4.72394 14.0052 5.51256C14.3319 6.30117 14.5 7.14641 14.5 8" stroke="currentColor" />
  </svg>
)

/** Regular one-pixel IconCompactOutline artwork. */
export const IconCompactOutlineRegular = (props: IconProps) => (
  <IconCompactOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconCompactOutline artwork with a 1.3px stroke. */
export const IconCompactOutlineMedium = (props: IconProps) => (
  <IconCompactOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconShieldOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d={SHIELD_OUTLINE_PATH} stroke="currentColor" strokeLinejoin="round" />
  </svg>
)

/** Regular one-pixel IconShieldOutline artwork. */
export const IconShieldOutlineRegular = (props: IconProps) => (
  <IconShieldOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconShieldOutline artwork with a 1.3px stroke. */
export const IconShieldOutlineMedium = (props: IconProps) => (
  <IconShieldOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconCheckCircleOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path
      d="M12.5303 6.53027L8.80273 10.2578C8.54967 10.5109 8.31796 10.7439 8.10645 10.9141C7.88375 11.0932 7.616 11.2602 7.27344 11.3145C7.09229 11.3431 6.90771 11.3431 6.72656 11.3145C6.384 11.2602 6.11625 11.0932 5.89355 10.9141C5.68204 10.7439 5.45033 10.5109 5.19727 10.2578L3.46973 8.53027L4.53027 7.46973L6.25781 9.19727C6.53457 9.47402 6.70036 9.63859 6.83398 9.74609C6.95637 9.84453 6.98241 9.83644 6.96094 9.83301C6.98679 9.83709 7.01321 9.83709 7.03906 9.83301C7.01759 9.83644 7.04363 9.84453 7.16602 9.74609C7.29964 9.63859 7.46543 9.47402 7.74219 9.19727L11.4697 5.46973L12.5303 6.53027Z"
      fill="currentColor"
    />
    <path
      d="M14.5996 8C14.5996 4.35492 11.6451 1.40039 8 1.40039C4.35492 1.40039 1.40039 4.35492 1.40039 8C1.40039 11.6451 4.35492 14.5996 8 14.5996C11.6451 14.5996 14.5996 11.6451 14.5996 8ZM15.9004 8C15.9004 12.363 12.363 15.9004 8 15.9004C3.63695 15.9004 0.0996094 12.363 0.0996094 8C0.0996094 3.63695 3.63695 0.0996094 8 0.0996094C12.363 0.0996094 15.9004 3.63695 15.9004 8Z"
      fill="currentColor"
    />
  </svg>
)

/** Regular one-pixel IconCheckCircleOutline artwork. */
export const IconCheckCircleOutlineRegular = (props: IconProps) => (
  <IconCheckCircleOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconCheckCircleOutline artwork with a 1.3px stroke. */
export const IconCheckCircleOutlineMedium = (props: IconProps) => (
  <IconCheckCircleOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconUnarchiveOutlineArtwork = ({ size = 20, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M15.8659 2.05975C17.2603 2.05995 18.3913 3.19096 18.3914 4.58527V5.4874C18.3914 6.02747 18.2192 6.52672 17.9303 6.93735C17.9336 6.96524 17.9388 6.99318 17.9388 7.02195V12.8884C17.9388 13.6345 17.9395 14.2379 17.8996 14.7254C17.8642 15.1593 17.7936 15.5499 17.6373 15.9141L17.5654 16.0685C17.278 16.6328 16.8405 17.1046 16.3038 17.434L16.0679 17.5661C15.66 17.7739 15.2196 17.8598 14.7237 17.9003C14.2362 17.9401 13.6327 17.9405 12.8867 17.9405H7.11122C6.36511 17.9405 5.76171 17.9401 5.27418 17.9003C4.84051 17.8649 4.44949 17.7952 4.08545 17.6391L3.93104 17.5661C3.36673 17.2785 2.89392 16.8414 2.56465 16.3044L2.43245 16.0685C2.22473 15.6608 2.13878 15.2211 2.09825 14.7254C2.05841 14.2379 2.05912 13.6345 2.05912 12.8884V7.02195C2.05912 6.99284 2.06422 6.96449 2.06758 6.93629C1.77931 6.52592 1.60858 6.02687 1.60858 5.4874V4.58527C1.60876 3.19084 2.73962 2.05975 4.1341 2.05975H15.8659ZM16.4984 7.92936C16.296 7.98169 16.0847 8.01288 15.8659 8.01291H4.1341C3.91478 8.01291 3.70246 7.98194 3.49955 7.92936V12.8884C3.49955 13.6582 3.50053 14.1927 3.53445 14.608C3.56769 15.0146 3.62923 15.244 3.71635 15.415L3.7925 15.5514C3.98339 15.8627 4.25749 16.1165 4.58464 16.2833L4.72529 16.3435C4.88095 16.3993 5.08638 16.4402 5.39158 16.4651C5.80685 16.4991 6.34138 16.5001 7.11122 16.5001H12.8867C13.6564 16.5001 14.1911 16.499 14.6063 16.4651C15.0128 16.432 15.2423 16.3703 15.4133 16.2833L15.5508 16.2061C15.8618 16.0152 16.116 15.7419 16.2827 15.415L16.3429 15.2732C16.3985 15.1177 16.4396 14.9128 16.4645 14.608C16.4985 14.1927 16.4984 13.6583 16.4984 12.8884V7.92936ZM4.1341 3.50019C3.53511 3.50019 3.0492 3.98631 3.04902 4.58527V5.4874C3.04902 6.08649 3.535 6.57248 4.1341 6.57248H15.8659C16.4648 6.57228 16.951 6.08638 16.951 5.4874V4.58527C16.9509 3.98644 16.4647 3.50038 15.8659 3.50019H4.1341Z"
      fill="currentColor"
    />
    <path d="M10 14.1V10.1M7.85 12.05L10 9.9L12.15 12.05" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** Regular one-pixel IconUnarchiveOutline artwork. */
export const IconUnarchiveOutlineRegular = (props: IconProps) => (
  <IconUnarchiveOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconUnarchiveOutline artwork with a 1.3px stroke. */
export const IconUnarchiveOutlineMedium = (props: IconProps) => (
  <IconUnarchiveOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconPinOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M9.96976 1.70572L13.1554 3.93629L10.9019 8.12317L11.5158 11.605L10.7192 12.7427L2.52767 7.00693L3.3243 5.86922L6.80612 5.25528L9.96976 1.70572Z" stroke="currentColor" strokeLinejoin="round" />
    <path d="M6.05285 9.47511C6.27284 9.16094 6.70586 9.08458 7.02003 9.30457C7.3342 9.52455 7.41055 9.95757 7.19057 10.2717L3.98587 14.4708L3.21223 13.9291L6.05285 9.47511Z" fill="currentColor" />
  </svg>
)

/** Regular one-pixel IconPinOutline artwork. */
export const IconPinOutlineRegular = (props: IconProps) => (
  <IconPinOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconPinOutline artwork with a 1.3px stroke. */
export const IconPinOutlineMedium = (props: IconProps) => (
  <IconPinOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconPinFillArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M9.96976 1.70572L13.1554 3.93629L10.9019 8.12317L11.5158 11.605L10.7192 12.7427L2.52767 7.00693L3.3243 5.86922L6.80612 5.25528L9.96976 1.70572Z" fill="currentColor" stroke="currentColor" strokeLinejoin="round" />
    <path d="M6.05285 9.47511C6.27284 9.16094 6.70586 9.08458 7.02003 9.30457C7.3342 9.52455 7.41055 9.95757 7.19057 10.2717L3.98587 14.4708L3.21223 13.9291L6.05285 9.47511Z" fill="currentColor" />
  </svg>
)

/** Regular one-pixel IconPinFill artwork. */
export const IconPinFillRegular = (props: IconProps) => (
  <IconPinFillArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconPinFill artwork with a 1.3px stroke. */
export const IconPinFillMedium = (props: IconProps) => (
  <IconPinFillArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconFlatListOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeLinecap="round" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M6 3.5h7.5M6 8h7.5M6 12.5h7.5" />
    <path d="M2.6 3.5h.01M2.6 8h.01M2.6 12.5h.01" />
  </svg>
)

/** Regular one-pixel IconFlatListOutline artwork. */
export const IconFlatListOutlineRegular = (props: IconProps) => (
  <IconFlatListOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconFlatListOutline artwork with a 1.3px stroke. */
export const IconFlatListOutlineMedium = (props: IconProps) => (
  <IconFlatListOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconWorkspaceTreeOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M14 12.05c0 .8-.65 1.45-1.46 1.45H3.46C2.65 13.5 2 12.85 2 12.05v-8.1c0-.8.65-1.45 1.46-1.45h2.4c.49 0 .94.24 1.21.65l.5.73c.27.4.73.65 1.21.65h3.76c.8 0 1.46.65 1.46 1.45v6.02Z" />
    <path d="M8.7 8.1v3M11.2 8.1v3" />
  </svg>
)

/** Regular one-pixel IconWorkspaceTreeOutline artwork. */
export const IconWorkspaceTreeOutlineRegular = (props: IconProps) => (
  <IconWorkspaceTreeOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconWorkspaceTreeOutline artwork with a 1.3px stroke. */
export const IconWorkspaceTreeOutlineMedium = (props: IconProps) => (
  <IconWorkspaceTreeOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconChevronsUpDownOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="m5.1 6 2.9-2.9L10.9 6" />
    <path d="m5.1 10 2.9 2.9 2.9-2.9" />
  </svg>
)

/** Regular one-pixel IconChevronsUpDownOutline artwork. */
export const IconChevronsUpDownOutlineRegular = (props: IconProps) => (
  <IconChevronsUpDownOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconChevronsUpDownOutline artwork with a 1.3px stroke. */
export const IconChevronsUpDownOutlineMedium = (props: IconProps) => (
  <IconChevronsUpDownOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconArchiveOffOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => {
  // The mask carves whitespace along the slash out of the box strokes, so the
  // id must stay unique per rendered instance.
  const maskId = `dsh-archive-off-${useId().replaceAll(':', '')}`
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" strokeWidth={strokeWidth}>
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
        <rect x="0" y="0" width="16" height="16" fill="white" stroke="none" />
        <path d="m2.2 1.3 11.6 12.8" stroke="black" strokeWidth={strokeWidth + 3} />
      </mask>
      <g mask={`url(#${maskId})`}>
        <rect x="1.9" y="2.1" width="12.2" height="3.4" rx="1.1" />
        <path d="M2.95 5.7v4.8a2.9 2.9 0 0 0 2.9 2.9h4.3a2.9 2.9 0 0 0 2.9-2.9V5.7" />
      </g>
      <path d="m2.2 1.3 11.6 12.8" />
    </svg>
  )
}

/** Regular one-pixel IconArchiveOffOutline artwork. */
export const IconArchiveOffOutlineRegular = (props: IconProps) => (
  <IconArchiveOffOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconArchiveOffOutline artwork with a 1.3px stroke. */
export const IconArchiveOffOutlineMedium = (props: IconProps) => (
  <IconArchiveOffOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconArchiveCheckOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" strokeWidth={strokeWidth}>
    <rect x="1.9" y="2.1" width="12.2" height="3.4" rx="1.1" />
    <path d="M2.95 5.7v4.8a2.9 2.9 0 0 0 2.9 2.9h4.3a2.9 2.9 0 0 0 2.9-2.9V5.7" />
    <path d="m6 9.35 1.4 1.4 2.6-2.6" />
  </svg>
)

/** Regular one-pixel IconArchiveCheckOutline artwork. */
export const IconArchiveCheckOutlineRegular = (props: IconProps) => (
  <IconArchiveCheckOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconArchiveCheckOutline artwork with a 1.3px stroke. */
export const IconArchiveCheckOutlineMedium = (props: IconProps) => (
  <IconArchiveCheckOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconSlidersTwoOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeLinecap="round" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M2.3 5h5.85M12.05 5h1.65" />
    <circle cx="9.95" cy="5" r="1.45" />
    <path d="M2.3 11h1.65M7.85 11h5.85" />
    <circle cx="5.75" cy="11" r="1.45" />
  </svg>
)

/** Regular one-pixel IconSlidersTwoOutline artwork. */
export const IconSlidersTwoOutlineRegular = (props: IconProps) => (
  <IconSlidersTwoOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Medium IconSlidersTwoOutline artwork with a 1.3px stroke. */
export const IconSlidersTwoOutlineMedium = (props: IconProps) => (
  <IconSlidersTwoOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)

const IconMicrophoneOutlineArtwork = ({ size = 16, className, strokeWidth }: WeightedIconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth} aria-hidden="true">
    <rect x={4.5 + strokeWidth / 2} y={1 + strokeWidth / 2} width={7 - strokeWidth} height={10 - strokeWidth} rx={(7 - strokeWidth) / 2} />
    <path d="M2.35 8.675C3.075 11.3 5.2 13.125 8 13.125C10.8 13.125 12.925 11.3 13.65 8.675M8 13.125V15" />
  </svg>
)

/** Microphone with uniform one-pixel strokes. */
export const IconMicrophoneOutlineRegular = (props: IconProps) => (
  <IconMicrophoneOutlineArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
)

/** Microphone with uniform 1.3px strokes. */
export const IconMicrophoneOutlineMedium = (props: IconProps) => (
  <IconMicrophoneOutlineArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
)
