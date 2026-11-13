<script setup lang="ts">
import { useNav } from "@slidev/client";
import { computed } from "vue";

import MotorLab from "./components/MotorLab.vue";

const { currentFrontmatter, clicks, isPrintMode } = useNav();
const demo = computed(() => currentFrontmatter.value.motor === "demo");
</script>

<template>
  <MotorLab :demo="demo" :step="clicks" :static-frame="isPrintMode" />
</template>

<style>
.slidev-layout.motor-cover,
.slidev-layout.motor-intro,
.motor-cover .slidev-layout,
.motor-intro .slidev-layout {
  background: radial-gradient(ellipse at 74% 45%, #143e64, #071726 74%);
  color: #edf7ff;
  padding: 52px 60px;
}
.slidev-layout.motor-intro > *,
.motor-intro .slidev-layout > * {
  max-width: 49%;
}
.slidev-layout.motor-intro h1,
.motor-intro .slidev-layout h1 {
  margin-top: 80px;
  font-size: 42px;
  letter-spacing: -0.04em;
}
.slidev-layout.motor-cover h1,
.motor-cover .slidev-layout h1 {
  font-size: 80px;
  letter-spacing: -0.07em;
}
.slidev-layout.motor-cover p,
.motor-cover .slidev-layout p,
.slidev-layout.motor-intro p,
.motor-intro .slidev-layout p {
  color: #b9d7ee;
  opacity: 1;
}
.slidev-layout.motor-intro code,
.motor-intro .slidev-layout code {
  color: #d0ebff;
  background: #163854;
}
</style>
