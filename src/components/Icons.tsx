interface P {
  size?: number
}

const svg = (path: React.ReactNode, size = 16) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    /*
      An inline SVG sits on a text baseline and carries descender space below
      it, so centring the box leaves every icon riding a couple of pixels high.
    */
    style={{ display: 'block' }}
  >
    {path}
  </svg>
)

export const Plus = ({ size }: P) => svg(<><path d="M8 3.5v9M3.5 8h9" /></>, size)
export const Layers = ({ size }: P) =>
  svg(<><path d="M8 2 2 5l6 3 6-3-6-3Z" /><path d="M2 11l6 3 6-3" /><path d="M2 8l6 3 6-3" /></>, size)
export const Bookmark = ({ size }: P) => svg(<path d="M4 2.5h8v11l-4-3-4 3v-11Z" />, size)
export const ChevronDown = ({ size }: P) => svg(<path d="M4 6.5 8 10l4-3.5" />, size)
export const ChevronRight = ({ size }: P) => svg(<path d="M6.5 4 10 8l-3.5 4" />, size)
export const ChevronLeft = ({ size }: P) => svg(<path d="M9.5 4 6 8l3.5 4" />, size)
export const Pencil = ({ size }: P) =>
  svg(<><path d="M11.2 2.9 13.1 4.8 5.4 12.5l-2.6.7.7-2.6 7.7-7.7Z" /></>, size)
export const Search = ({ size }: P) => svg(<><circle cx="7.2" cy="7.2" r="4" /><path d="m10.2 10.2 3 3" /></>, size)
export const Sliders = ({ size }: P) =>
  svg(<><path d="M3 5h5M11 5h2M3 11h2M8 11h5" /><circle cx="9.5" cy="5" r="1.4" /><circle cx="6.5" cy="11" r="1.4" /></>, size)
export const Dot = ({ size }: P) => svg(<circle cx="8" cy="8" r="2.4" />, size)
export const Warning = ({ size }: P) =>
  svg(<><path d="M8 2.8 14 13H2L8 2.8Z" /><path d="M8 6.8v2.6M8 11.2v.01" /></>, size)
export const Cross = ({ size }: P) => svg(<path d="M4 4l8 8M12 4l-8 8" />, size)
export const Terminal = ({ size }: P) => svg(<><path d="m3.5 5 2.5 3-2.5 3" /><path d="M8.5 11h4" /></>, size)
export const Diff = ({ size }: P) =>
  svg(<><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M8 5v6M5 8h6" /></>, size)
export const Globe = ({ size }: P) =>
  svg(<><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.7 2.4 3.6 2.4 5.5S9.6 12.3 8 13.5C6.4 12.3 5.6 10.4 5.6 8S6.4 4.2 8 2.5Z" /></>, size)
export const Folder = ({ size }: P) => svg(<path d="M2.5 12.5v-9h4l1.5 2h5.5v7h-11Z" />, size)
export const PanelLeft = ({ size }: P) =>
  svg(<><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M6.5 3v10" /></>, size)
export const Code = ({ size }: P) => svg(<><path d="m5.5 5.5-3 2.5 3 2.5M10.5 5.5l3 2.5-3 2.5" /></>, size)
export const Send = ({ size }: P) => svg(<path d="M8 13V3.5M4 7l4-3.5L12 7" />, size)
export const Stop = ({ size }: P) => svg(<rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" />, size)
export const Star = ({ size }: P) =>
  svg(<path d="m8 2.8 1.6 3.3 3.6.5-2.6 2.5.6 3.6L8 11l-3.2 1.7.6-3.6L2.8 6.6l3.6-.5L8 2.8Z" />, size)
export const Copy = ({ size }: P) =>
  svg(<><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" /><path d="M10.5 3.5h-7a1 1 0 0 0-1 1v7" /></>, size)
export const Trash = ({ size }: P) => svg(<><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" /></>, size)
export const Refresh = ({ size }: P) =>
  svg(<><path d="M13 8a5 5 0 1 1-1.6-3.7" /><path d="M13.2 2.6v3h-3" /></>, size)
export const Anchor = ({ size }: P) =>
  svg(<><circle cx="8" cy="3.6" r="1.5" /><path d="M8 5.1v8.3M4.4 7.2h7.2M2.6 9.6a5.5 5.5 0 0 0 10.8 0" /></>, size)
/** A return glyph: the send key. */
export const Return = ({ size }: P) => svg(<><path d="M12.5 4v4.5h-8" /><path d="m6.5 6.5-2 2 2 2" /></>, size)
export const Check = ({ size }: P) => svg(<path d="m3.5 8.5 3 3 6-7" />, size)
/** A quick question: a spark, here and gone. */
export const Spark = ({ size }: P) => svg(<path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.2 4.2l2 2M9.8 9.8l2 2M4.2 11.8l2-2M9.8 6.2l2-2" />, size)
/** Word wrap: a line that turns back. */
export const Wrap = ({ size }: P) => svg(<><path d="M3 4h10M3 8h7.5a2 2 0 0 1 0 4H9" /><path d="m10.5 10.5-1.5 1.5 1.5 1.5" /><path d="M3 12h3" /></>, size)
/** A run with a director: a compass. */
export const PopOut = ({ size }: P) => svg(<><path d="M7 3.5H3.5v9h9V9" /><path d="M9 3.5h3.5V7M12.5 3.5 7.5 8.5" /></>, size)
export const Compass = ({ size }: P) => svg(<><circle cx="8" cy="8" r="5.5" /><path d="m10.5 5.5-1.5 4-4 1.5 1.5-4z" /></>, size)
