---
theme: default
title: oxifoc
info: FOC motor control in Rust — talk slides
colorSchema: light
transition: slide-left
mdc: true
mcp: false
class: motor-cover
---

# oxifoc

FOC-контроллер BLDC на Rust

---
layout: default
class: motor-intro
---

# Тот же код — в браузере

`oxifoc-core` → `wasm32-unknown-unknown`: `FocDriver`, контур скорости,
оценка угла по датчикам Холла или back-EMF, SVPWM и виртуальный мотор.

В браузере тот же `step()`, что и в ISR на f405. Частота симуляции 15 кГц.

---
layout: full
motor: demo
clicks: 3
transition: fade
---

<!--
0. Показать мотор целиком.
1. Разрез корпуса: статор, обмотки и магниты ротора.
2. Velocity Control: ступень задания скорости и нагрузка на валу.
3. Current Control: импульс Iq и реакция момента и скорости.
-->

---
layout: default
class: motor-intro
transition: fade
---

# Ток и скорость

Контур тока задаёт момент. Контур скорости подбирает ток, чтобы удерживать обороты под нагрузкой.
