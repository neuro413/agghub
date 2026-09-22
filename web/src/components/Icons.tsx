import type { SVGProps, ReactNode } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function S({ size = 18, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconChannels = (p: IconProps) => (
  <S {...p}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="2.6" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="2.6" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="2.6" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2.6" />
  </S>
)

export const IconStats = (p: IconProps) => (
  <S {...p}>
    <path d="M4 19.5V5" />
    <path d="M4 19.5H20" />
    <rect x="7" y="12" width="3" height="5" rx="1.4" />
    <rect x="12" y="9" width="3" height="8" rx="1.4" />
    <rect x="17" y="6" width="3" height="11" rx="1.4" />
  </S>
)

export const IconSettings = (p: IconProps) => (
  <S {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 12a7.4 7.4 0 0 0-.1-1.3l1.9-1.5-2-3.4-2.3.9a7.3 7.3 0 0 0-2.2-1.3L14.3 2h-4l-.4 2.4a7.3 7.3 0 0 0-2.2 1.3l-2.3-.9-2 3.4 1.9 1.5a7.4 7.4 0 0 0 0 2.6L2.7 15.4l2 3.4 2.3-.9a7.3 7.3 0 0 0 2.2 1.3l.4 2.4h4l.4-2.4a7.3 7.3 0 0 0 2.2-1.3l2.3.9 2-3.4-1.9-1.5c.06-.43.1-.86.1-1.3Z" />
  </S>
)

export const IconPlus = (p: IconProps) => (
  <S {...p}>
    <path d="M12 5v14M5 12h14" />
  </S>
)

export const IconEdit = (p: IconProps) => (
  <S {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </S>
)

export const IconTrash = (p: IconProps) => (
  <S {...p}>
    <path d="M3 6h18" />
    <path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6" />
    <path d="M5.5 6 6.5 20a1.5 1.5 0 0 0 1.5 1.4h8a1.5 1.5 0 0 0 1.5-1.4L18.5 6" />
    <path d="M10 11v5M14 11v5" />
  </S>
)

export const IconTest = (p: IconProps) => (
  <S {...p}>
    <path d="M21 12h-4l-3 7-4-14-3 7H3" />
  </S>
)

export const IconCopy = (p: IconProps) => (
  <S {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2.6" />
    <path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" />
  </S>
)

export const IconClose = (p: IconProps) => (
  <S {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </S>
)

export const IconCheck = (p: IconProps) => (
  <S {...p}>
    <path d="M4 12.5 9 17.5 20 6.5" />
  </S>
)

export const IconBolt = (p: IconProps) => (
  <S {...p}>
    <path d="M13 2 4 14h7l-1 8 9-12h-7Z" />
  </S>
)

export const IconSearch = (p: IconProps) => (
  <S {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </S>
)

export const IconRefresh = (p: IconProps) => (
  <S {...p}>
    <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" />
    <path d="M21 4v4h-4" />
    <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" />
    <path d="M3 20v-4h4" />
  </S>
)

export const IconChevron = (p: IconProps) => (
  <S {...p}>
    <path d="M6 9l6 6 6-6" />
  </S>
)

export const IconExternal = (p: IconProps) => (
  <S {...p}>
    <path d="M14 4h6v6" />
    <path d="M20 4 10 14" />
    <path d="M19 14v5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 19V7a1.5 1.5 0 0 1 1.5-1.5H10" />
  </S>
)

export const IconWarn = (p: IconProps) => (
  <S {...p}>
    <path d="M12 3.5 22 19.5H2L12 3.5Z" />
    <path d="M12 10v4M12 17.5h.01" />
  </S>
)

export const IconSpark = (p: IconProps) => (
  <S {...p}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
  </S>
)

export const IconTrend = (p: IconProps) => (
  <S {...p}>
    <path d="M3 16.5 9 10l4 4 8-9" />
    <path d="M21 9.5V5h-4.5" />
  </S>
)

export const IconLogs = (p: IconProps) => (
  <S {...p}>
    <path d="M5 3.5h11l3 3V20a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 20V5a1.5 1.5 0 0 1 1-1.5Z" />
    <path d="M15 3.5V7h3.5" />
    <path d="M8 12h8M8 16h5" />
  </S>
)

export const IconFilter = (p: IconProps) => (
  <S {...p}>
    <path d="M3 5h18l-7 8.5V20l-4 1.5v-8L3 5Z" />
  </S>
)

export const IconChevronLeft = (p: IconProps) => (
  <S {...p}>
    <path d="M15 6l-6 6 6 6" />
  </S>
)

export const IconChevronRight = (p: IconProps) => (
  <S {...p}>
    <path d="M9 6l6 6-6 6" />
  </S>
)

export const IconEye = (p: IconProps) => (
  <S {...p}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </S>
)

export const IconEyeOff = (p: IconProps) => (
  <S {...p}>
    <path d="M3 3l18 18" />
    <path d="M10.6 6.2A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.3 4" />
    <path d="M6.5 7.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 4.4-1" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </S>
)

export const IconWand = (p: IconProps) => (
  <S {...p}>
    <path d="M4 20 13.5 10.5" />
    <path d="M11.5 8.5l4 4" />
    <path d="M17.5 3v3.2M21 5.5h-3.2M19.8 2.7 17.6 4.9" />
    <path d="M7 4v2M8 5H6" />
  </S>
)

export const IconGrip = (p: IconProps) => (
  <S {...p}>
    <circle cx="9" cy="6" r="1" />
    <circle cx="9" cy="12" r="1" />
    <circle cx="9" cy="18" r="1" />
    <circle cx="15" cy="6" r="1" />
    <circle cx="15" cy="12" r="1" />
    <circle cx="15" cy="18" r="1" />
  </S>
)
