<script setup>
import { useBooks } from "../store/loadBooks";
const index = inject("index");
const toces = inject("toces");
const containerRef = ref(null);
const book = ref(null);
const bookInfo = inject("bookInfo");
const images = ref([]);
const cssVars = useBooks().cssVarsData;

const loadEPUB = async (bookPath) => {
  book.value = await getEPUB(bookPath);
  console.log(book.value);

  for (const section of book.value.sections) {
    const doc = await section.createDocument();
    doc.body.setAttribute("flag", section.id.split("/")[1]);
    const imgList = doc.body.querySelectorAll("img");

    for (const img of imgList) {
      const part = img.src.split("/");
      const blob = await book.value.loadBlob(
        `${book.value.resources.cover.href.split("/")[0]}/${
          part[part.length - 1]
        }`
      );
      const url = URL.createObjectURL(blob);
      img.src = url;
      images.value.push(url);
    }
    containerRef.value.appendChild(doc.body);
  }
  toces.value = book.value.toc;

  for (const item of book.value.resources.manifest) {
    if (item.mediaType === "text/css") {
      const style = document.createElement("style");
      const css = await book.value.loadText(item.href);
      style.textContent = css;
      containerRef.value.appendChild(style);
    }
  }
};

onMounted(async () => {
  await loadEPUB(bookInfo.value.path);
  index.value.total = Math.ceil(
    containerRef.value.scrollHeight / containerRef.value.clientHeight
  );
});

onUnmounted(() => {
  images.value.forEach((url) => URL.revokeObjectURL(url));
});

const jump = (href) => {
  const goal = getGoal(href);
  goal?.scrollIntoView({ behavior: "smooth" }); // 平滑滚动
};

const getGoal = (href) => {
  const part = href.split("/");
  const parts = part[part.length - 1].split("#");
  let goal;
  if (parts.length === 1) {
    goal = containerRef.value.querySelector(`[flag='${parts[0]}']`);
  } else {
    goal = containerRef.value.querySelector(`#${parts[1]}`);
  }
  return goal;
};

const left = () => {
  index.value.nowIndex -= 1;
  containerRef.value.scrollBy({
    top: -containerRef.value.clientHeight,
    behavior: "smooth",
  });
};

const right = () => {
  index.value.nowIndex += 1;
  containerRef.value.scrollBy({
    top: containerRef.value.clientHeight,
    behavior: "smooth",
  });
};

defineExpose({
  jump,
  left,
  right,
});
const x = ref(0);
const y = ref(0);
const showPopover = ref(false);
const popover = ref("");

const loadIndex = (e) => {
  e.preventDefault();
  showPopover.value = false;
  if (e.target.tagName === "A") {
    if (!e.target.id || e.target.id.endsWith("n")) {
      jump(e.target.href);
    } else {
      const note = getGoal(e.target.href).parentNode;
      if (!showPopover.value) {
        showPopover.value = true;
        x.value = e.clientX;
        y.value = e.clientY;
      }
      popover.value = note.innerText;
    }
  }
  index.value.total = Math.ceil(
    containerRef.value.scrollHeight / containerRef.value.clientHeight
  );
  index.value.nowIndex = Math.floor(
    containerRef.value.scrollTop / containerRef.value.clientHeight
  );
};
</script>

<template>
  <div>
    <n-popover
      :show="showPopover"
      :x="x"
      :y="y"
      trigger="manual"
      :width="'30vw'"
    >
      {{ popover }}
    </n-popover>
    <div ref="containerRef" class="text" @click="loadIndex"></div>
  </div>
</template>

<style scoped lang="scss">
.text {
  height: 100vh;
  overflow-y: auto;
  scrollbar-width: none;
  overflow-x: hidden;
  font-size: v-bind("cssVars.fontSize + 'px'");
  * {
    font-family: "TangHan";
  }

  :deep([class*="toc"]) {
    a {
      color: var(--color) !important;
    }
  }

  :deep(p) {
    padding: 0 2vw;
    margin-bottom: v-bind("cssVars.marginBottom + 'em'");
    font-size: v-bind("cssVars.fontSize + 'px'");
    letter-spacing: v-bind("cssVars.letterSpacing + 'px'");
    line-height: v-bind("cssVars.lineHeight");

    a {
      padding: 0;
    }
  }

  :deep(a) {
    text-decoration: none;
    padding: 0 2vw;
    padding-bottom: var(--p-margin-bottom);
    overflow-wrap: break-word;
    color: var(--a-color) !important;
  }

  :deep(h2),
  :deep(h3) {
    padding: 0 2vw;
    color: var(--color) !important;
  }

  :deep(img) {
    max-width: 100%;
    width: -webkit-fill-available;
    height: auto;
    display: block;
    margin: 0 auto;
  }
}

:deep(div.chubanshe) {
  position: inherit;
}
</style>
