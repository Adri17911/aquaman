import { useCallback, useEffect, useRef, useState } from 'react'

/** Curve points: [minutes since midnight (0-1440), brightness percent (0-100)] */
export type CurvePoint = [number, number]

const MINUTES_PER_DAY = 24 * 60
const W = 400
const H = 120
const POINT_R = 8

function toSvg([m, p]: CurvePoint): [number, number] {
  const x = (m / MINUTES_PER_DAY) * W
  const y = H - (p / 100) * H
  return [x, y]
}

function fromSvg(x: number, y: number): CurvePoint {
  const m = Math.round(Math.max(0, Math.min(MINUTES_PER_DAY, (x / W) * MINUTES_PER_DAY)))
  const p = Math.round(Math.max(0, Math.min(100, (1 - y / H) * 100)))
  return [m, p]
}

interface CurveEditorProps {
  points: CurvePoint[]
  onChange: (points: CurvePoint[]) => void
  disabled?: boolean
}

export function CurveEditor({ points, onChange, disabled }: CurveEditorProps) {
  const [dragging, setDragging] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const getSvgPoint = useCallback((e: React.MouseEvent | MouseEvent) => {
    const svg = svgRef.current
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * W
    const y = ((e.clientY - rect.top) / rect.height) * H
    return { x, y }
  }, [])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, sortedIndex: number) => {
      if (disabled) return
      e.preventDefault()
      setDragging(sortedIndex)
    },
    [disabled]
  )

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (dragging === null) return
      const pt = getSvgPoint(e)
      if (!pt) return
      const [m, percent] = fromSvg(pt.x, pt.y)
      const sorted = [...points].sort((a, b) => a[0] - b[0])
      const prevM = dragging > 0 ? sorted[dragging - 1][0] : 0
      const nextM = dragging < sorted.length - 1 ? sorted[dragging + 1][0] : MINUTES_PER_DAY
      const clampedM = Math.max(prevM + 1, Math.min(nextM - 1, m))
      const clampedP = Math.max(0, Math.min(100, percent))
      const targetPoint = sorted[dragging]
      const pointIndex = points.findIndex((p) => p[0] === targetPoint[0] && p[1] === targetPoint[1])
      const newPoints = points.map((p, i) =>
        i === pointIndex ? [clampedM, clampedP] as CurvePoint : [...p]
      )
      onChange(newPoints.sort((a, b) => a[0] - b[0]) as CurvePoint[])
    },
    [dragging, points, onChange, getSvgPoint]
  )

  const handleMouseUp = useCallback(() => {
    setDragging(null)
  }, [])

  const handleMouseLeave = useCallback(() => {
    if (dragging !== null) setDragging(null)
  }, [dragging])

  const addPoint = useCallback(
    (e: React.MouseEvent) => {
      if (disabled || points.length >= 12) return
      const pt = getSvgPoint(e)
      if (!pt) return
      const [m, p] = fromSvg(pt.x, pt.y)
      const sorted = [...points, [m, p] as CurvePoint].sort((a, b) => a[0] - b[0])
      onChange(sorted)
    },
    [disabled, points, onChange, getSvgPoint]
  )

  const removePoint = useCallback(
    (index: number) => {
      if (points.length <= 2) return
      onChange(points.filter((_, i) => i !== index))
    },
    [points, onChange]
  )

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [handleMouseMove, handleMouseUp])

  const sorted = [...points].sort((a, b) => a[0] - b[0])
  const pathD = sorted.map(toSvg).reduce((acc, [x, y], i) => acc + (i ? ' L ' : 'M ') + x + ' ' + y, '')

  return (
    <div className="space-y-2">
      <div className="text-xs text-slate-500">Drag points to adjust. Click line to add, double-click point to remove.</div>
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="h-[120px] w-full max-w-[400px] cursor-crosshair rounded-lg border border-slate-700 bg-slate-800/80"
          onMouseDown={addPoint}
          onMouseLeave={handleMouseLeave}
          style={{ touchAction: 'none' }}
        >
          <defs>
            <linearGradient id="curve-fill" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0" stopColor="#22d3ee" stopOpacity="0.2" />
              <stop offset="1" stopColor="#22d3ee" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={pathD + ' L ' + W + ' ' + H + ' L 0 ' + H + ' Z'} fill="url(#curve-fill)" />
          <path d={pathD} fill="none" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          {sorted.map((pt, i) => {
            const [x, y] = toSvg(pt)
            return (
              <g key={i}>
                <circle
                  cx={x}
                  cy={y}
                  r={POINT_R}
                  fill={dragging === i ? '#22d3ee' : '#0e7490'}
                  stroke="#22d3ee"
                  strokeWidth="2"
                  className="cursor-grab active:cursor-grabbing"
                  style={{ pointerEvents: 'all' }}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    handleMouseDown(e, i)
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    removePoint(points.indexOf(pt))
                  }}
                />
              </g>
            )
          })}
        </svg>
        <div className="absolute bottom-1 left-1 text-[10px] text-slate-500">0h</div>
        <div className="absolute bottom-1 right-1 text-[10px] text-slate-500">24h</div>
      </div>
      <div className="flex flex-wrap gap-1 text-[10px] text-slate-400">
        {sorted.map(([m, p], i) => {
          const h = Math.floor(m / 60)
          const min = m % 60
          return (
            <span key={i} className="rounded bg-slate-700/50 px-1.5 py-0.5">
              {String(h).padStart(2, '0')}:{String(min).padStart(2, '0')} → {p}%
            </span>
          )
        })}
      </div>
    </div>
  )
}

/** Default curve: 0% until 7:00, ramp to 100% by 7:30, 100% until 21:00, ramp down by 21:30 */
export const DEFAULT_CURVE: CurvePoint[] = [
  [0, 0],
  [420, 0],
  [450, 100],
  [1260, 100],
  [1290, 0],
  [1440, 0],
]
