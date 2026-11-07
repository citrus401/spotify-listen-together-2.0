import React from 'react';

// 16px line icons, drawn for this. currentColor so they follow whatever text color they're in
const Svg = ({ children, size = 16 }: { children: React.ReactNode; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const Icons = {
  broadcast: (p: { size?: number }) => (
    <Svg {...p}>
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
      <path d="M5.2 5.2a4 4 0 0 0 0 5.6M10.8 5.2a4 4 0 0 1 0 5.6" />
      <path d="M3 3a7 7 0 0 0 0 10M13 3a7 7 0 0 1 0 10" />
    </Svg>
  ),
  copy: (p: { size?: number }) => (
    <Svg {...p}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.8" />
      <path d="M10.5 3.2A1.8 1.8 0 0 0 8.8 2H4.3A1.8 1.8 0 0 0 2.5 3.8v4.5a1.8 1.8 0 0 0 1.2 1.7" />
    </Svg>
  ),
  check: (p: { size?: number }) => (
    <Svg {...p}>
      <path d="M3 8.5l3.2 3L13 4.5" />
    </Svg>
  ),
  back: (p: { size?: number }) => (
    <Svg {...p}>
      <path d="M10 3L5 8l5 5" />
    </Svg>
  ),
  // 8 tooth gear, generated (R 6.7, r 5, teeth 17deg wide)
  cog: (p: { size?: number }) => (
    <Svg {...p}>
      <path d="M6.71 3.17L7.01 1.37L8.99 1.37L9.29 3.17L10.50 3.67L11.99 2.61L13.39 4.01L12.33 5.50L12.83 6.71L14.63 7.01L14.63 8.99L12.83 9.29L12.33 10.50L13.39 11.99L11.99 13.39L10.50 12.33L9.29 12.83L8.99 14.63L7.01 14.63L6.71 12.83L5.50 12.33L4.01 13.39L2.61 11.99L3.67 10.50L3.17 9.29L1.37 8.99L1.37 7.01L3.17 6.71L3.67 5.50L2.61 4.01L4.01 2.61L5.50 3.67Z" />
      <circle cx="8" cy="8" r="2" />
    </Svg>
  ),
  leave: (p: { size?: number }) => (
    <Svg {...p}>
      <path d="M6 2.5H3.8A1.3 1.3 0 0 0 2.5 3.8v8.4a1.3 1.3 0 0 0 1.3 1.3H6" />
      <path d="M10 5l3 3-3 3M13 8H6" />
    </Svg>
  ),
  server: (p: { size?: number }) => (
    <Svg {...p}>
      <rect x="2.5" y="2.5" width="11" height="4.5" rx="1.3" />
      <rect x="2.5" y="9" width="11" height="4.5" rx="1.3" />
      <path d="M5 4.75h.01M5 11.25h.01" strokeWidth={2.2} />
    </Svg>
  ),
  crown: (p: { size?: number }) => (
    <Svg {...p}>
      <path d="M2.5 5l2.8 2.5L8 3.5l2.7 4L13.5 5l-1.2 6.5H3.7z" />
    </Svg>
  ),
  heart: (p: { size?: number }) => (
    <Svg {...p}>
      <path d="M8 13.2S2.5 10 2.5 6.2A2.9 2.9 0 0 1 8 4.7a2.9 2.9 0 0 1 5.5 1.5C13.5 10 8 13.2 8 13.2z" />
    </Svg>
  ),
  github: (p: { size?: number }) => (
    <Svg {...p}>
      <path d="M6 13c-3 .9-3-1.5-4.2-1.8M10 14.5v-2.3a2 2 0 0 0-.6-1.6c2-.2 4.1-1 4.1-4.4a3.4 3.4 0 0 0-.9-2.4 3.2 3.2 0 0 0-.1-2.4s-.8-.2-2.5.9a8.6 8.6 0 0 0-4.5 0C3.8 1.2 3 1.4 3 1.4a3.2 3.2 0 0 0-.1 2.4 3.4 3.4 0 0 0-.9 2.4c0 3.4 2.1 4.2 4.1 4.4a2 2 0 0 0-.6 1.6v2.3" />
    </Svg>
  ),
};
