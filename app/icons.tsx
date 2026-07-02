/**
 * Inline SVG icon set (feather/lucide-style strokes). stroke=currentColor so
 * icons tint with text color — active/hover states come for free.
 */

function Svg({ size = 20, children }: { size?: number; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const CalendarIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <rect x="3" y="4" width="18" height="17" rx="2.5" />
    <path d="M8 2.5v4M16 2.5v4M3 9.5h18" />
    <path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01" />
  </Svg>
);

export const KanbanIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <rect x="3" y="3" width="18" height="18" rx="2.5" />
    <path d="M8 7.5v9M12 7.5v5M16 7.5v7" />
  </Svg>
);

export const BotIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <rect x="4" y="9" width="16" height="11" rx="2.5" />
    <path d="M12 5.5V9" />
    <circle cx="12" cy="4" r="1.4" />
    <path d="M9 13.5v2M15 13.5v2" />
  </Svg>
);

export const MoonIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </Svg>
);

export const CheckCircleIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 12.3l2.4 2.4 4.8-5.2" />
  </Svg>
);

export const PlusIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const RefreshIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M23 4v6h-6" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </Svg>
);

export const ClockIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </Svg>
);

export const PersonIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="12" cy="8" r="3.8" />
    <path d="M4.5 20.5c.8-3.8 3.9-6 7.5-6s6.7 2.2 7.5 6" />
  </Svg>
);

export const TerminalIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M7 9l3.5 3L7 15M12.5 15H17" />
  </Svg>
);
