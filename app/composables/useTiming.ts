/**
 * 防抖与节流。
 *
 * 用在哪、为什么：
 *   - 检索调试的输入框：边打字边发请求既费钱又乱序 → 防抖（停下来再发）
 *   - 上传/继续处理按钮：连点会开多个轮询循环 → 节流（固定间隔最多一次）
 *   - 回答结束后的指标刷新：一轮里可能触发多次 → 节流
 *
 * 不引 lodash：这两个函数各十几行，自己写还能顺手把「组件卸载时取消」
 * 这件事说清楚（cancel 方法）。
 */

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  wait = 300,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const wrapped = (...args: A) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), wait)
  }
  wrapped.cancel = () => clearTimeout(timer)
  wrapped.flush = (...args: A) => {
    clearTimeout(timer)
    fn(...args)
  }
  return wrapped
}

export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  wait = 500,
) {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: A | null = null

  const invoke = (args: A) => {
    last = Date.now()
    pending = null
    fn(...args)
  }
  const wrapped = (...args: A) => {
    const now = Date.now()
    const remain = wait - (now - last)
    if (remain <= 0) {
      clearTimeout(timer)
      invoke(args)
      return
    }
    // 末次调用也要落地（trailing），否则最后一次点击会被丢掉
    pending = args
    if (!timer) {
      timer = setTimeout(() => {
        timer = undefined
        if (pending) invoke(pending)
      }, remain)
    }
  }
  wrapped.cancel = () => {
    clearTimeout(timer)
    timer = undefined
    pending = null
  }
  return wrapped
}
