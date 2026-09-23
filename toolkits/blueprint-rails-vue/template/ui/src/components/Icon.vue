<!-- The app's icon set (AGENT-OWNED): one consistent inline-SVG set (16px
     grid, stroke-based). Icons are decorative beside their text label, so
     they are aria-hidden; icon-only buttons carry an aria-label instead. -->
<script setup>
const ICON_PATHS = {
  plus: "M8 3v10M3 8h10",
  check: "M3 8.5 6.5 12 13 4.5",
  trash: "M2.5 4.5h11M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5m2.5 0V13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4.5",
  alert: "M8 5.5V9m0 2.5v.01M8 1.5 1.5 13.5h13L8 1.5Z",
  info: "M8 7.5V11m0-5.5v-.01M14.5 8a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z",
  inbox: "M1.5 9.5h3l1 2h5l1-2h3M2.5 3.5h11l1 6v3a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-3l1-6Z",
  refresh: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v2.6h-2.6",
};

const props = defineProps({
  name: { type: String, required: true },
  size: { type: Number, default: 16 },
});
</script>

<template>
  <svg viewBox="0 0 16 16" :width="props.size" :height="props.size" fill="none" aria-hidden="true">
    <path
      :d="ICON_PATHS[props.name] ?? ICON_PATHS.info"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>
