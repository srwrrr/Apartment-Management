import { memo } from 'react';

/** The same windows every time: this is decoration, so it must never flicker between renders. */
function lit(col: number, row: number) {
  const n = Math.sin(col * 12.9898 + row * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

function Tower({ x, width, top, cols, rows }: { x: number; width: number; top: number; cols: number; rows: number }) {
  const pad = 18;
  const gapX = (width - pad * 2) / cols;
  const gapY = 46;
  const windows = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const v = lit(c + x, r);
      if (v < 0.52) continue;
      windows.push(<rect key={`${c}-${r}`} x={x + pad + c * gapX} y={top + 24 + r * gapY} width={gapX - 12} height={26} rx={2} fill={v > 0.86 ? '#ffd9a0' : v > 0.68 ? '#e8b468' : '#7ce8cb'} opacity={v > 0.86 ? 0.2 : 0.11} />);
    }
  }
  return (
    <g>
      <rect x={x} y={top} width={width} height={900 - top} fill="#0e1f1a" />
      <rect x={x} y={top} width={width} height={1.5} fill="#ffffff" opacity={0.06} />
      {windows}
    </g>
  );
}

/**
 * The light behind the glass: dusk, and a building with some windows lit. Purely decorative and fixed in place,
 * so panes scrolling over it show the blur moving. It holds no text and no information.
 */
export const Ambient = memo(function Ambient() {
  return (
    <div aria-hidden="true" className="ambient pointer-events-none fixed inset-0 -z-10 overflow-hidden" data-testid="ambient">
      <div className="absolute inset-0 bg-[radial-gradient(60rem_38rem_at_8%_-8%,rgb(38_150_124/0.26),transparent_70%),radial-gradient(48rem_34rem_at_92%_4%,rgb(70_96_150/0.2),transparent_70%),radial-gradient(52rem_34rem_at_78%_108%,rgb(232_180_104/0.14),transparent_70%)]" />
      <svg className="absolute bottom-0 end-0 h-[92vh] max-w-none opacity-60 sm:opacity-100 [mask-image:linear-gradient(to_left,#000_45%,transparent_95%)]" viewBox="0 0 900 900" preserveAspectRatio="xMaxYMax meet">
        <Tower x={70} width={230} top={420} cols={4} rows={10} />
        <Tower x={320} width={270} top={150} cols={5} rows={16} />
        <Tower x={610} width={290} top={300} cols={5} rows={13} />
      </svg>
    </div>
  );
});
