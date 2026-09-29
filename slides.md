---
theme: default
title: oxifoc
info: FOC motor control in Rust — talk slides
colorSchema: light
transition: slide-left
mdc: true
---

# oxifoc

FOC-контроллер BLDC на Rust

---
layout: center
---

# Тот же код — в браузере

`oxifoc-core` → `wasm32-unknown-unknown`: `FocDriver`, velocity loop, back-EMF observer,
sensorless cold start, SVPWM — и виртуальный мотор, против которого всё это тестируется.

Никакого JS-порта: ровно тот `step()`, который на f405 крутится в ISR на 20 kHz.

---
layout: full
---

<MotorLab />
