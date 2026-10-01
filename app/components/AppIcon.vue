<script setup lang="ts">
/**
 * 最小图标集：内联 SVG，stroke 用 currentColor，跟着文字颜色走。
 * 不引第三方图标库，保持零依赖；要加图标就往 PATHS 里加一条。
 */
const PATHS: Record<string, string> = {
  plus: 'M8 3.4v9.2M3.4 8h9.2',
  upload: 'M8 11.2V3.6M4.9 6.6 8 3.5l3.1 3.1M3.2 12.6h9.6',
  sparkles: 'M8 2.6l1.25 3.2 3.2 1.25-3.2 1.25L8 11.5 6.75 8.3 3.55 7.05 6.75 5.8 8 2.6zM12.4 10.2l.55 1.35 1.35.55-1.35.55-.55 1.35-.55-1.35-1.35-.55 1.35-.55.55-1.35z',
  send: 'M8 12.8V3.6M4.9 6.7 8 3.6l3.1 3.1',
  panel: 'M13 3.4H3a1 1 0 0 0-1 1v7.2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V4.4a1 1 0 0 0-1-1zM9.6 3.5v9',
  search: 'M7.2 12.3a5.1 5.1 0 1 0 0-10.2 5.1 5.1 0 0 0 0 10.2zM11 11.1l2.9 2.9',
  file: 'M9.1 2.6H5.2a1 1 0 0 0-1 1v8.8a1 1 0 0 0 1 1h5.6a1 1 0 0 0 1-1V5.2L9.1 2.6zM9.1 2.6v2.9h2.7',
  link: 'M6.6 9.4 9.4 6.6M6.9 4.7l.9-.9a2.6 2.6 0 0 1 3.7 3.7l-.9.9M9.1 11.3l-.9.9a2.6 2.6 0 0 1-3.7-3.7l.9-.9',
  chart: 'M3.2 13V3.2M3.2 13h9.6M6.2 10.8V8.2M8.9 10.8V5.6M11.5 10.8V7.1',
  close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
}

const props = defineProps<{ name: keyof typeof PATHS | string, size?: number }>()
</script>

<template>
  <svg
    class="icon"
    :width="props.size ?? 15"
    :height="props.size ?? 15"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <path
      :d="PATHS[props.name] || ''"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<style scoped>
.icon { flex: none; }
</style>
