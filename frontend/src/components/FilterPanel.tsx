import { useCallback, useEffect, useState } from 'react'
import {
  sendFilterCommand,
  getCommandStatus,
  getLatestTelemetry,
  type FilterBleScanResult,
  type TelemetryPoint,
} from '../api'
import { useToast } from '../contexts/ToastContext'

const ACK_SHORT_MS = 8000
const ACK_BIND_MS = 22000
const ACK_CONNECT_MS = 35000
const ACK_SCAN_MS = 25000
const ACK_POLL_MS = 100
const SCAN_RESULTS_POLL_MS = 350
const SCAN_RESULTS_WAIT_MS = 20000

interface FilterPanelProps {
  deviceId: string
  telemetry: TelemetryPoint | null
  refetchTelemetry: () => void
}

type AckWait = 'acked' | 'backend_timeout' | 'wait_timeout'

export function FilterPanel({ deviceId, telemetry, refetchTelemetry }: FilterPanelProps) {
  const toast = useToast()
  const [pending, setPending] = useState<string | null>(null)
  const [lastUiError, setLastUiError] = useState<string | null>(null)
  const [scanList, setScanList] = useState<FilterBleScanResult[]>([])
  const [selectedAddress, setSelectedAddress] = useState('')
  const [scanHint, setScanHint] = useState('')
  const [scanBarPct, setScanBarPct] = useState(0)

  useEffect(() => {
    if (pending !== 'ble_scan') return
    const t0 = Date.now()
    const id = window.setInterval(() => {
      const elapsed = Date.now() - t0
      setScanBarPct((prev) => {
        if (prev >= 95) return prev
        const target = Math.min(88, 6 + (elapsed / 13000) * 82)
        return Math.max(prev, target)
      })
    }, 120)
    return () => clearInterval(id)
  }, [pending])

  const waitAckResult = useCallback(async (correlationId: string, timeoutMs: number): Promise<AckWait> => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      try {
        const status = await getCommandStatus(correlationId)
        if (status.status === 'ACKED') return 'acked'
        if (status.status === 'TIMEOUT') return 'backend_timeout'
      } catch {
        /* command row may lag after publish, or transient network */
      }
      await new Promise((r) => setTimeout(r, ACK_POLL_MS))
    }
    return 'wait_timeout'
  }, [])

  const explainAckFailure = (res: AckWait) => {
    if (res === 'backend_timeout') {
      return 'The server marked this command as timed out before the controller replied. Check ESP32 and MQTT, or increase mqtt.command_timeout_seconds in settings (or AQUA_COMMAND_TIMEOUT_SECONDS in Docker).'
    }
    return 'No acknowledgment from the controller in time. Check ESP32, MQTT, and that firmware uses deferred ack/filter publishes.'
  }

  const runAction = async (action: string, timeoutMs: number) => {
    setLastUiError(null)
    setPending(action)
    try {
      const { correlation_id } = await sendFilterCommand(deviceId, action)
      const res = await waitAckResult(correlation_id, timeoutMs)
      if (res !== 'acked') {
        const msg = explainAckFailure(res)
        setLastUiError(msg)
        toast(msg, 'error')
      }
      refetchTelemetry()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setLastUiError(msg)
      toast(msg, 'error')
    } finally {
      setPending(null)
    }
  }

  const runActionPayload = async (
    action: string,
    payload: Record<string, unknown>,
    timeoutMs: number
  ) => {
    setLastUiError(null)
    setPending(action)
    try {
      const { correlation_id } = await sendFilterCommand(deviceId, action, payload)
      const res = await waitAckResult(correlation_id, timeoutMs)
      if (res === 'acked') {
        if (action === 'bind_ble') {
          toast('Bluetooth address saved on the ESP32. You can use Connect or scan again.', 'success')
        }
      } else {
        const msg = explainAckFailure(res)
        setLastUiError(msg)
        toast(action === 'bind_ble' ? `Could not save address: ${msg}` : msg, 'error')
      }
      refetchTelemetry()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setLastUiError(msg)
      toast(msg, 'error')
    } finally {
      setPending(null)
    }
  }

  const handleBleScan = async () => {
    setLastUiError(null)
    setScanHint('Sending scan command to your controller…')
    setScanBarPct(4)
    setPending('ble_scan')
    let userMsg: string | null = null
    try {
      const { correlation_id } = await sendFilterCommand(deviceId, 'ble_scan')
      setScanHint('Waiting for the ESP32 to acknowledge (MQTT)…')
      setScanBarPct((p) => Math.max(p, 16))
      const scanAck = await waitAckResult(correlation_id, ACK_SCAN_MS)
      if (scanAck !== 'acked') {
        userMsg =
          scanAck === 'backend_timeout'
            ? 'Scan command timed out on the server before the ESP32 acknowledged. Increase command_timeout_seconds or check MQTT.'
            : 'Scan command was not acknowledged (check ESP32 / MQTT).'
      } else {
        setScanHint('Bluetooth scan running on the ESP32 (about 5 seconds). Keep the pump powered nearby.')
        setScanBarPct((p) => Math.max(p, 34))
        const deadline = Date.now() + SCAN_RESULTS_WAIT_MS
        let results: FilterBleScanResult[] | null = null
        while (Date.now() < deadline) {
          const t = await getLatestTelemetry(deviceId)
          if (t?.filter_scan_status === 'error') {
            userMsg = 'BLE scan failed on the controller.'
            break
          }
          const r = t?.filter_scan_results
          if (Array.isArray(r) && r.length > 0) {
            results = r.filter((row): row is FilterBleScanResult => typeof row?.address === 'string')
            if (results.length > 0) break
          }
          await new Promise((r) => setTimeout(r, SCAN_RESULTS_POLL_MS))
        }
        if (!userMsg) {
          if (results && results.length > 0) {
            setScanList(results)
            setSelectedAddress((prev) =>
              results!.some((row) => row.address === prev) ? prev : results![0].address
            )
            setScanBarPct(100)
            setScanHint(`Found ${results.length} device(s). Pick one below, then Use this address.`)
            await new Promise((r) => setTimeout(r, 900))
          } else {
            userMsg =
              'No Bluetooth devices in telemetry yet. If your ESP32 firmware does not handle the ble_scan command, update it so scan results are published in telemetry.'
          }
        }
      }
    } catch (e) {
      userMsg = e instanceof Error ? e.message : String(e)
    } finally {
      setPending(null)
      setScanBarPct(0)
      setScanHint('')
      if (userMsg) setLastUiError(userMsg)
      refetchTelemetry()
    }
  }

  const handleBindBle = () => {
    const addr = selectedAddress.trim()
    if (!addr) return
    void runActionPayload('bind_ble', { address: addr }, ACK_BIND_MS)
  }

  const fromTelemetry = telemetry?.filter_scan_results
  const displayList: FilterBleScanResult[] =
    scanList.length > 0
      ? scanList
      : Array.isArray(fromTelemetry)
        ? fromTelemetry.filter((row): row is FilterBleScanResult => typeof row?.address === 'string')
        : []

  const t = telemetry
  const bleOk = t?.filter_ble_connected === true
  const bleOff = t?.filter_ble_connected === false
  const powerStr =
    t?.filter_power === true ? 'ON' : t?.filter_power === false ? 'OFF' : '—'
  const modeStr = t?.filter_mode && t.filter_mode !== 'unknown' ? t.filter_mode : '—'
  const blobStr = t?.filter_state_blob_hex?.trim()
    ? t.filter_state_blob_hex.length > 48
      ? `${t.filter_state_blob_hex.slice(0, 48)}…`
      : t.filter_state_blob_hex
    : '—'
  const errStr = t?.filter_ble_error?.trim() || lastUiError || '—'
  const addrStr = t?.filter_last_address?.trim() || '—'
  const scanStatusStr = t?.filter_scan_status?.trim()

  const scanBusy = pending === 'ble_scan'
  const bindBusy = pending === 'bind_ble'
  const otherFilterBusy = pending !== null && !scanBusy && !bindBusy

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
      <h2 className="mb-1 font-display text-sm font-medium text-slate-300">
        AQUAEL UltraMax BT (via ESP32 bridge)
      </h2>
      <p className="mb-3 text-xs text-slate-500">
        Commands go to your aquarium controller over MQTT; the ESP32 connects to the filter over Bluetooth. Close the vendor app so only one central connects.
      </p>

      <div className="mb-4 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
        <p className="mb-2 text-xs text-slate-500">
          Pick the pump using Bluetooth Low Energy on the ESP32 (not Wi‑Fi). Run a scan while the device is powered and advertising, choose the correct row, bind the address, then press Connect.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <button
            type="button"
            disabled={scanBusy || bindBusy}
            onClick={() => void handleBleScan()}
            className="rounded-lg bg-indigo-700 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
          >
            {pending === 'ble_scan' ? 'Scanning…' : 'Scan for Bluetooth devices'}
          </button>
          <select
            className="min-w-[12rem] rounded-lg border border-slate-600 bg-slate-900 px-2 py-2 text-sm text-slate-200 disabled:opacity-50"
            value={selectedAddress}
            onChange={(e) => setSelectedAddress(e.target.value)}
            disabled={scanBusy || displayList.length === 0}
          >
            <option value="">Select device…</option>
            {displayList.map((row) => {
              const label = row.name?.trim() || 'Unknown'
              const rssi =
                row.rssi != null && Number.isFinite(row.rssi) ? `, ${row.rssi} dBm` : ''
              return (
                <option key={row.address} value={row.address}>
                  {label} ({row.address}
                  {rssi})
                </option>
              )
            })}
          </select>
          <button
            type="button"
            disabled={bindBusy || scanBusy || !selectedAddress.trim()}
            onClick={handleBindBle}
            className="rounded-lg bg-slate-600 px-3 py-2 text-sm font-medium text-slate-100 hover:bg-slate-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pending === 'bind_ble' ? 'Saving…' : 'Use this address'}
          </button>
        </div>
        {bindBusy && (
          <div className="mt-2 space-y-1" role="status" aria-live="polite">
            <p className="text-xs text-slate-400">
              Writing address to the ESP32 (NVS) and waiting for MQTT acknowledgment…
            </p>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
              <div className="h-full w-full animate-pulse rounded-full bg-slate-500/80" />
            </div>
          </div>
        )}
        {(pending === 'ble_scan' || scanHint) && (
          <div
            className="mt-3 space-y-1.5"
            role="status"
            aria-live="polite"
            aria-busy={pending === 'ble_scan'}
          >
            {scanHint && (
              <p className="text-xs text-indigo-200/90">{scanHint}</p>
            )}
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-slate-800"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(scanBarPct)}
              aria-label="Bluetooth scan progress"
            >
              <div
                className="h-full rounded-full bg-gradient-to-r from-indigo-600 to-violet-500 transition-[width] duration-200 ease-out"
                style={{ width: `${Math.min(100, scanBarPct)}%` }}
              />
            </div>
          </div>
        )}
        {(scanStatusStr || displayList.length > 0) && (
          <p className="mt-2 text-xs text-slate-500">
            {displayList.length > 0 ? (
              <>
                {displayList.length} device(s) in last results
                {scanStatusStr ? ` · status: ${scanStatusStr}` : ''}
              </>
            ) : (
              scanStatusStr && <>Last scan status: {scanStatusStr}</>
            )}
          </p>
        )}
      </div>

      <div className="mb-4 grid gap-2 text-xs text-slate-400 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <span className="text-slate-500">Filter BLE: </span>
          {bleOk ? <span className="text-emerald-400">Connected</span> : bleOff ? <span className="text-rose-400">Disconnected</span> : <span>Unknown</span>}
        </div>
        <div>
          <span className="text-slate-500">Power: </span>
          <span className="text-slate-200">{powerStr}</span>
        </div>
        <div>
          <span className="text-slate-500">Mode: </span>
          <span className="text-slate-200">{modeStr}</span>
        </div>
        <div className="sm:col-span-2 lg:col-span-3">
          <span className="text-slate-500">State blob (hex): </span>
          <span className="break-all font-mono text-slate-300">{blobStr}</span>
        </div>
        <div>
          <span className="text-slate-500">Last address: </span>
          <span className="font-mono text-slate-300">{addrStr}</span>
        </div>
        <div className="sm:col-span-2">
          <span className="text-slate-500">Error: </span>
          <span className="text-rose-300/90">{errStr}</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={otherFilterBusy || scanBusy}
          onClick={() => runAction('connect', ACK_CONNECT_MS)}
          className="rounded-lg bg-cyan-700 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-50"
        >
          {pending === 'connect' ? '…' : 'Connect'}
        </button>
        <button
          type="button"
          disabled={otherFilterBusy || scanBusy}
          onClick={() => runAction('disconnect', ACK_SHORT_MS)}
          className="rounded-lg bg-slate-600 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-500 disabled:opacity-50"
        >
          {pending === 'disconnect' ? '…' : 'Disconnect'}
        </button>
        <button
          type="button"
          disabled={otherFilterBusy || scanBusy || !bleOk}
          onClick={() => runAction('on', ACK_SHORT_MS)}
          className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending === 'on' ? '…' : 'Filtration on'}
        </button>
        <button
          type="button"
          disabled={otherFilterBusy || scanBusy || !bleOk}
          onClick={() => runAction('off', ACK_SHORT_MS)}
          className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending === 'off' ? '…' : 'Filtration off'}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {(
          [
            ['mode_constant', 'Constant'],
            ['mode_pulse', 'Pulse'],
            ['mode_dashed', 'Dashed'],
            ['mode_sine', 'Sine'],
          ] as const
        ).map(([action, label]) => (
          <button
            key={action}
            type="button"
            disabled={otherFilterBusy || scanBusy || !bleOk}
            onClick={() => runAction(action, ACK_SHORT_MS)}
            className="rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pending === action ? '…' : label}
          </button>
        ))}
        <button
          type="button"
          disabled={otherFilterBusy || scanBusy || !bleOk}
          onClick={() => runAction('read_state', ACK_SHORT_MS)}
          className="rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending === 'read_state' ? '…' : 'Read state'}
        </button>
      </div>
    </div>
  )
}
