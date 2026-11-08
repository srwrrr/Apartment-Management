/** The app's mark: a small block of windows with one light on. */
export function BrandMark({ className = 'size-9' }: { className?: string }) {
  return (
    <svg className={`flex-none ${className}`} viewBox="0 0 36 36" aria-hidden="true">
      <rect width="36" height="36" rx="10" fill="#7ce8cb" fillOpacity="0.14" />
      <rect x="0.5" y="0.5" width="35" height="35" rx="9.5" fill="none" stroke="#fff" strokeOpacity="0.16" />
      {[10, 20].map((x) => [9, 16, 23].map((y) => <rect key={`${x}-${y}`} x={x} y={y} width="6" height="4.5" rx="1" fill={x === 20 && y === 16 ? '#e8b468' : '#7ce8cb'} fillOpacity={x === 20 && y === 16 ? 1 : 0.5} />))}
    </svg>
  );
}
