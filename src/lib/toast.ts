// Tiny global toast channel; <ToastHost /> subscribes while mounted.
let listener: ((msg: string) => void) | null = null

export function toast(msg: string) {
  listener?.(msg)
}

export function onToast(fn: ((msg: string) => void) | null) {
  listener = fn
}
