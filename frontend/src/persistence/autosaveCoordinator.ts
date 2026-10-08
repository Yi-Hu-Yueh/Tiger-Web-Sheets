export const AUTOSAVE_DELAY = 3_000
export const RECOVERY_DELAY = 500
export const RECOVERY_MAX_WAIT = 2_000

type Clock = { set: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>; clear: (timer: ReturnType<typeof setTimeout>) => void }
const clock: Clock = { set: (callback, delay) => setTimeout(callback, delay), clear: clearTimeout }

/** One serialized drain for manual and automatic saves. No snapshots on mutation. */
export class AutosaveCoordinator {
  private timer?: ReturnType<typeof setTimeout>
  private recoveryTimer?: ReturnType<typeof setTimeout>
  private recoveryMaxTimer?: ReturnType<typeof setTimeout>
  private active?: Promise<boolean>
  private manual = false
  private stopped = false
  private blocked = false
  private dirty = false
  constructor(private readonly options: {
    generation: () => number
    eligible: () => boolean
    save: () => Promise<{ ok: boolean; generation: number }>
    checkpoint: () => Promise<void>
    recoveryError: (error: unknown) => void
    clock?: Clock
  }) {}
  private get clock() { return this.options.clock ?? clock }
  mutation() {
    if (this.stopped) return
    this.dirty = true
    this.clock.clear(this.recoveryTimer!)
    this.recoveryTimer = this.clock.set(() => this.checkpoint(), RECOVERY_DELAY)
    this.recoveryMaxTimer ??= this.clock.set(() => this.checkpoint(), RECOVERY_MAX_WAIT)
    this.schedule()
  }
  private checkpoint() {
    this.clock.clear(this.recoveryTimer!); this.clock.clear(this.recoveryMaxTimer!)
    this.recoveryTimer = this.recoveryMaxTimer = undefined
    if (!this.stopped && this.dirty) void this.options.checkpoint().catch(this.options.recoveryError)
  }
  suspend() { this.clock.clear(this.timer!); this.timer = undefined }
  block() { this.blocked = true; this.suspend() }
  resume(retry = false) { if (retry) this.blocked = false; this.schedule() }
  private schedule() {
    this.suspend()
    if (!this.stopped && this.dirty && !this.blocked && !this.active && this.options.eligible()) {
      this.timer = this.clock.set(() => { this.timer = undefined; void this.start(false) }, AUTOSAVE_DELAY)
    }
  }
  flush(): Promise<boolean> { this.suspend(); this.blocked = false; return this.start(true) }
  private start(manual: boolean): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false)
    this.manual ||= manual
    if (this.active) return this.active
    if (!manual && !this.options.eligible()) { this.schedule(); return Promise.resolve(false) }
    this.active = this.drain().finally(() => {
      this.active = undefined; this.manual = false; this.schedule()
    })
    return this.active
  }
  private async drain(): Promise<boolean> {
    do {
      let result: { ok: boolean; generation: number }
      try { result = await this.options.save() }
      catch (error) { this.options.recoveryError(error); result = { ok: false, generation: -1 } }
      if (this.stopped) return false
      if (!result.ok) { this.blocked = true; this.checkpoint(); return false }
      this.dirty = result.generation !== this.options.generation()
      if (!this.dirty) { this.clock.clear(this.recoveryTimer!); this.clock.clear(this.recoveryMaxTimer!); this.recoveryTimer = this.recoveryMaxTimer = undefined }
    } while (this.manual && this.dirty)
    return !this.dirty
  }
  dispose() {
    this.stopped = true; this.suspend()
    this.clock.clear(this.recoveryTimer!); this.clock.clear(this.recoveryMaxTimer!)
  }
}
