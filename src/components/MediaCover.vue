<script setup>
import Icon from "./Icon.vue";

defineOptions({ name: "MediaCover" });

const props = defineProps({
  kind: { type: String, default: "" },
  ext: { type: String, default: "" },
  count: { type: [Number, String], default: 0 },
  childCount: { type: [Number, String], default: 0 },
  videoCount: { type: [Number, String], default: 0 },
  imageCount: { type: [Number, String], default: 0 },
  index: { type: Number, default: 0 },
  folder: { type: String, default: "" },
  src: { type: String, default: "" },
  // 是否显示角标（格式/类型 + 来源文件夹）；书架类视图由「显示来源」设置控制
  meta: { type: Boolean, default: true },
});

const isVideo = computed(() => props.kind === "video" || props.kind === "video-folder");
const isMixed = computed(() => props.kind === "media-folder");
const isGroup = computed(() => props.kind === "group");
const tone = computed(() => (isGroup.value ? "group" : isVideo.value ? "video" : isMixed.value ? "media" : "image"));
const iconId = computed(() => (isGroup.value ? "layers" : isVideo.value ? "play" : isMixed.value ? "layers" : "image"));
const hoverId = computed(() => (isGroup.value ? "folder-open" : isVideo.value ? "play" : isMixed.value ? "film" : "scan"));
const label = computed(() => {
  if (props.kind === "group") return `${props.childCount || props.count} 项`;
  if (props.kind === "video-folder") return `${props.count} 集`;
  if (props.kind === "image-folder") return `${props.count} 张`;
  if (props.kind === "media-folder") return `视频 ${props.videoCount} · 图片 ${props.imageCount}`;
  const ext = String(props.ext || "").toUpperCase();
  return ext || (isVideo.value ? "VIDEO" : "IMAGE");
});
const caption = computed(() => (isGroup.value ? "SERIES" : isVideo.value ? "MOTION" : isMixed.value ? "MIXED" : "STILL"));
</script>

<template>
  <div class="media-cover" :class="`is-${tone}`">
    <img v-if="src" :src="src" class="media-cover-img" alt="" loading="lazy" decoding="async" />
    <span v-else class="media-art">
      <span class="media-index mono">{{ String(index + 1).padStart(2, "0") }}</span>
      <span class="media-glyph"><Icon :id="iconId" :size="28" :stroke-width="1.8" /></span>
      <span class="media-caption mono">{{ caption }}</span>
      <span class="media-hash" aria-hidden="true"></span>
      <span class="media-line" aria-hidden="true"></span>
    </span>
    <span v-if="meta" class="media-ext mono">{{ label }}</span>
    <span v-if="meta && folder" class="media-folder mono">{{ folder }}</span>
    <span class="media-overlay">
      <span class="media-overlay-glyph"><Icon :id="hoverId" :size="20" :stroke-width="2" /></span>
    </span>
  </div>
</template>

<style scoped lang="scss">
.media-cover {
  --media-a: #ff4d2e;
  --media-b: #ff9a3d;
  --media-c: #ffd166;

  position: relative;
  aspect-ratio: 1 / 1.414;
  border-radius: 10px;
  overflow: hidden;
  background: var(--bg-2);
  box-shadow: var(--shadow-1);
  cursor: pointer;
  transition: transform 0.45s var(--ease-spring), box-shadow 0.45s var(--ease-out);

  &.is-video {
    --media-a: #ff4d2e;
    --media-b: #ff9a3d;
    --media-c: #ffd166;
  }

  &.is-image {
    --media-a: #1f6feb;
    --media-b: #5b8cff;
    --media-c: #9db8ff;
  }

  &.is-media {
    --media-a: #ff4d2e;
    --media-b: #5b8cff;
    --media-c: #9db8ff;
  }

  &.is-group {
    --media-a: #7a9e00;
    --media-b: #a3c92a;
    --media-c: #d6ff3f;
  }

  &:hover {
    transform: translateY(-6px) scale(1.02);
    box-shadow: var(--shadow-2);

    .media-cover-img {
      transform: scale(1.045);
    }

    .media-art {
      transform: scale(1.045);
    }

    .media-glyph {
      transform: scale(1.08);
    }

    .media-overlay {
      opacity: 1;

      .media-overlay-glyph {
        transform: scale(1);
      }
    }
  }
}

.media-cover-img {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.6s var(--ease-out);
}

.media-art {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background:
    radial-gradient(90% 70% at 22% 12%, rgba(255, 255, 255, 0.16), transparent 55%),
    linear-gradient(155deg, var(--media-a) 0%, var(--media-b) 58%, var(--media-c) 130%);
  overflow: hidden;
  transition: transform 0.6s var(--ease-out);

  &::after {
    content: "";
    position: absolute;
    inset: 0;
    background:
      linear-gradient(180deg, rgba(0, 0, 0, 0.22), transparent 34%),
      linear-gradient(0deg, rgba(0, 0, 0, 0.34), transparent 38%);
    pointer-events: none;
  }
}

.is-image .media-hash {
  position: absolute;
  inset: 0;
  opacity: 0.34;
  background:
    linear-gradient(90deg, transparent 32%, rgba(255, 255, 255, 0.5) 33%, transparent 34%),
    linear-gradient(180deg, transparent 32%, rgba(255, 255, 255, 0.5) 33%, transparent 34%);
  background-size: 33.34% 33.34%;
  pointer-events: none;
}

.is-media .media-hash {
  position: absolute;
  inset: 0;
  opacity: 0.3;
  background:
    linear-gradient(90deg, transparent 32%, rgba(255, 255, 255, 0.5) 33%, transparent 34%),
    linear-gradient(180deg, transparent 32%, rgba(255, 255, 255, 0.5) 33%, transparent 34%);
  background-size: 33.34% 33.34%;
  pointer-events: none;
}

.is-video .media-hash {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 10px;
  width: 5px;
  opacity: 0.62;
  background: repeating-linear-gradient(180deg, rgba(255, 255, 255, 0.72) 0 3px, transparent 3px 11px);
  pointer-events: none;
}

.media-index {
  position: absolute;
  top: 13px;
  left: 15px;
  z-index: 1;
  font-size: 9.5px;
  letter-spacing: 0.2em;
  color: rgba(255, 255, 255, 0.78);
}

.media-caption {
  position: absolute;
  top: 15px;
  right: 14px;
  z-index: 1;
  font-size: 8.5px;
  letter-spacing: 0.24em;
  color: rgba(255, 255, 255, 0.66);
}

.media-glyph {
  position: relative;
  z-index: 1;
  width: 58px;
  height: 58px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.13);
  border: 1px solid rgba(255, 255, 255, 0.34);
  color: #fff;
  backdrop-filter: blur(9px);
  box-shadow: 0 14px 38px rgba(0, 0, 0, 0.28);
  transition: transform 0.4s var(--ease-spring);
}

.media-line {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 0;
  height: 1px;
  z-index: 1;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.7), transparent 78%);
}

.media-ext,
.media-folder {
  position: absolute;
  bottom: 8px;
  z-index: 2;
  padding: 3px 7px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.55);
  color: rgba(255, 255, 255, 0.9);
  font-size: 9px;
  letter-spacing: 0.12em;
  backdrop-filter: blur(6px);
}

.media-ext {
  right: 8px;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-folder {
  left: 8px;
  max-width: 54%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(255, 255, 255, 0.82);
}

.media-overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: grid;
  place-items: center;
  background: rgba(5, 5, 8, 0.34);
  backdrop-filter: blur(2px);
  opacity: 0;
  transition: opacity 0.35s var(--ease-out);

  &::after {
    content: "";
    position: absolute;
    left: 18px;
    right: 18px;
    bottom: 12px;
    height: 1px;
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.55), transparent);
  }
}

.media-overlay-glyph {
  width: 46px;
  height: 46px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.14);
  border: 1px solid rgba(255, 255, 255, 0.34);
  color: #fff;
  transform: scale(0.82);
  transition: transform 0.32s var(--ease-spring), background 0.3s;
}

/* 触屏（hover:none）：无悬停语义，禁用悬浮位移与 hover 覆盖层；
   按下时的 :active 缩放手感由调用方按钮提供，这里不额外加 */
@media (hover: none) {
  .media-cover:hover,
  .media-cover:hover .media-cover-img,
  .media-cover:hover .media-art,
  .media-cover:hover .media-glyph {
    transform: none;
  }

  .media-cover:hover .media-overlay {
    opacity: 0;
  }
}
</style>
