import { useCallback, useEffect, useState } from 'react'
import {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  Schedule,
} from '../api'
import { CurveEditor, DEFAULT_CURVE, type CurvePoint } from './CurveEditor'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function daysToStr(days: number[]): string {
  return [...days].sort((a, b) => a - b).join(',')
}

function strToDays(s: string): number[] {
  if (!s?.trim()) return [0, 1, 2, 3, 4, 5, 6]
  return s.split(',').map((d) => parseInt(d.trim(), 10)).filter((n) => !isNaN(n) && n >= 0 && n <= 6)
}

interface ScenariosProps {
  deviceId: string | null
}

interface FormState {
  scenarioType: 'dawn_dusk' | 'curve'
  name: string
  dawnTime: string
  duskTime: string
  dawnDuration: number
  duskDuration: number
  targetBrightness: number
  curvePoints: CurvePoint[]
  days: number[]
  enabled: boolean
}

const defaultForm: FormState = {
  scenarioType: 'dawn_dusk',
  name: '',
  dawnTime: '07:00',
  duskTime: '21:00',
  dawnDuration: 30,
  duskDuration: 30,
  targetBrightness: 100,
  curvePoints: DEFAULT_CURVE,
  days: [0, 1, 2, 3, 4, 5, 6],
  enabled: true,
}

export function Scenarios({ deviceId }: ScenariosProps) {
  const [open, setOpen] = useState(false)
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [editing, setEditing] = useState<Schedule | null>(null)
  const [form, setForm] = useState<FormState>(defaultForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!deviceId) return
    try {
      const list = await listSchedules(deviceId)
      setSchedules(list || [])
    } catch (_) {}
  }, [deviceId])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  const resetForm = useCallback(() => {
    setForm(defaultForm)
    setEditing(null)
  }, [])

  const startEdit = (s: Schedule) => {
    const isCurve = s.scenario_type === 'curve'
    let curvePoints: CurvePoint[] = DEFAULT_CURVE
    if (isCurve && s.curve_points && Array.isArray(s.curve_points) && s.curve_points.length >= 2) {
      curvePoints = (s.curve_points as [number, number][]).map((p) =>
        Array.isArray(p) && p.length >= 2 ? [p[0], p[1]] : [0, 0]
      ).filter(([m]) => m >= 0 && m <= 1440) as CurvePoint[]
      if (curvePoints.length < 2) curvePoints = DEFAULT_CURVE
    }
    setForm({
      scenarioType: isCurve ? 'curve' : 'dawn_dusk',
      name: s.name,
      dawnTime: s.dawn_time || '07:00',
      duskTime: s.dusk_time || '21:00',
      dawnDuration: s.dawn_duration_minutes ?? 30,
      duskDuration: s.dusk_duration_minutes ?? 30,
      targetBrightness: s.target_brightness ?? 100,
      curvePoints,
      days: strToDays(s.days_of_week),
      enabled: s.enabled,
    })
    setEditing(s)
    setError('')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!deviceId) return
    setSaving(true)
    setError('')
    const isCurve = form.scenarioType === 'curve'
    const curveJson = isCurve ? JSON.stringify(form.curvePoints) : undefined
    try {
      if (editing) {
        await updateSchedule(editing.id, {
          name: form.name.trim() || undefined,
          scenario_type: form.scenarioType,
          dawn_time: isCurve ? undefined : form.dawnTime,
          dusk_time: isCurve ? undefined : form.duskTime,
          dawn_duration_minutes: isCurve ? undefined : form.dawnDuration,
          dusk_duration_minutes: isCurve ? undefined : form.duskDuration,
          target_brightness: isCurve ? undefined : form.targetBrightness,
          days_of_week: daysToStr(form.days),
          enabled: form.enabled,
          curve_points: isCurve ? curveJson : null,
        })
      } else {
        await createSchedule({
          device_id: deviceId,
          name: form.name.trim() || (isCurve ? '24h curve' : 'Dawn & Dusk'),
          scenario_type: form.scenarioType,
          dawn_time: form.dawnTime,
          dusk_time: form.duskTime,
          dawn_duration_minutes: form.dawnDuration,
          dusk_duration_minutes: form.duskDuration,
          target_brightness: form.targetBrightness,
          days_of_week: daysToStr(form.days),
          enabled: form.enabled,
          curve_points: curveJson ?? null,
        })
      }
      resetForm()
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this schedule?')) return
    try {
      await deleteSchedule(id)
      if (editing?.id === id) resetForm()
      load()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete')
    }
  }

  const toggleDay = (d: number) => {
    setForm((f) => ({
      ...f,
      days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d].sort((a, b) => a - b),
    }))
  }

  if (!deviceId) return null

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between font-display text-sm font-medium text-slate-300 hover:text-slate-200"
      >
        <span>Scenarios (dawn & dusk)</span>
        <span className="text-slate-500">{open ? '▼' : '▶'}</span>
      </button>
      {open && (
        <div className="mt-4 space-y-4">
          <p className="text-xs text-slate-500">
            Dawn & dusk: gradual on/off at set times. 24h curve: drag points to define brightness over the day.
          </p>
          <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border border-slate-700 bg-slate-800/50 p-4">
            <div>
              <label className="mb-2 block text-xs text-slate-500">Schedule type</label>
              <div className="flex gap-2">
                <label className="flex cursor-pointer items-center gap-2 rounded border border-slate-600 bg-slate-800/50 px-3 py-2 transition hover:border-slate-500">
                  <input
                    type="radio"
                    name="scenarioType"
                    checked={form.scenarioType === 'dawn_dusk'}
                    onChange={() => setForm((f) => ({ ...f, scenarioType: 'dawn_dusk' }))}
                    className="border-slate-600"
                  />
                  <span className="text-sm text-slate-300">Dawn & dusk</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded border border-slate-600 bg-slate-800/50 px-3 py-2 transition hover:border-slate-500">
                  <input
                    type="radio"
                    name="scenarioType"
                    checked={form.scenarioType === 'curve'}
                    onChange={() => setForm((f) => ({ ...f, scenarioType: 'curve' }))}
                    className="border-slate-600"
                  />
                  <span className="text-sm text-slate-300">24h curve</span>
                </label>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">Name</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Weekend schedule"
                className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
            </div>
            {form.scenarioType === 'curve' ? (
              <div>
                <label className="mb-1 block text-xs text-slate-500">Brightness curve (24 hours)</label>
                <CurveEditor
                  points={form.curvePoints}
                  onChange={(pts) => setForm((f) => ({ ...f, curvePoints: pts }))}
                  disabled={saving}
                />
              </div>
            ) : (
            <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-slate-500">Dawn (turn on)</label>
                <input
                  type="time"
                  value={form.dawnTime}
                  onChange={(e) => setForm((f) => ({ ...f, dawnTime: e.target.value }))}
                  className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">Dusk (turn off)</label>
                <input
                  type="time"
                  value={form.duskTime}
                  onChange={(e) => setForm((f) => ({ ...f, duskTime: e.target.value }))}
                  className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-slate-500">Dawn fade (min)</label>
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={form.dawnDuration}
                  onChange={(e) => setForm((f) => ({ ...f, dawnDuration: Math.max(1, Math.min(120, parseInt(e.target.value, 10) || 30)) }))}
                  className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">Dusk fade (min)</label>
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={form.duskDuration}
                  onChange={(e) => setForm((f) => ({ ...f, duskDuration: Math.max(1, Math.min(120, parseInt(e.target.value, 10) || 30)) }))}
                  className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">Target brightness (%)</label>
              <input
                type="range"
                min={0}
                max={100}
                value={form.targetBrightness}
                onChange={(e) => setForm((f) => ({ ...f, targetBrightness: parseInt(e.target.value, 10) }))}
                className="h-2 w-full rounded-lg accent-cyan-500"
              />
              <span className="text-xs text-slate-400">{form.targetBrightness}%</span>
            </div>
            </>
            )}
            <div>
              <label className="mb-2 block text-xs text-slate-500">Days of week</label>
              <div className="flex flex-wrap gap-2">
                {DAY_NAMES.map((label, i) => (
                  <label key={i} className="flex cursor-pointer items-center gap-1.5 rounded border border-slate-600 bg-slate-800/50 px-2.5 py-1.5 transition hover:border-slate-500">
                    <input
                      type="checkbox"
                      checked={form.days.includes(i)}
                      onChange={() => toggleDay(i)}
                      className="rounded border-slate-600"
                    />
                    <span className="text-xs text-slate-300">{label}</span>
                  </label>
                ))}
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                className="rounded border-slate-600"
              />
              <span className="text-sm text-slate-300">Enabled</span>
            </label>
            {error && <p className="text-sm text-rose-400">{error}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-70"
              >
                {saving ? '…' : editing ? 'Update' : 'Add schedule'}
              </button>
              {editing && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
                >
                  Cancel
                </button>
              )}
            </div>
          </form>

          {schedules.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-medium text-slate-400">Existing schedules</h4>
              <ul className="space-y-2">
                {schedules.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2"
                  >
                    <div>
                      <span className="font-medium text-slate-200">{s.name || 'Unnamed'}</span>
                      <span className={`ml-2 text-xs ${s.enabled ? 'text-emerald-500' : 'text-slate-500'}`}>
                        {s.enabled ? 'On' : 'Off'}
                      </span>
                      <p className="text-xs text-slate-500">
                        {s.scenario_type === 'curve'
                          ? `24h curve · ${s.curve_points?.length ?? 0} points`
                          : `${s.dawn_time} → ${s.dusk_time} · ${s.target_brightness}% peak · fade ${s.dawn_duration_minutes}/${s.dusk_duration_minutes}m`}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={() => startEdit(s)}
                        className="rounded px-2 py-1 text-xs text-cyan-400 hover:bg-slate-700"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(s.id)}
                        className="rounded px-2 py-1 text-xs text-rose-400 hover:bg-slate-700"
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
