# No te la sabes

Juego multijugador de preguntas y respuestas inspirado en la estructura de **MercaPrecios** y alimentado con preguntas de **Trivial DB**.


## Qué incluye

- SPA estática en HTML, CSS/Tailwind CDN y JavaScript vanilla.
- Salas multijugador con `GameAPI.js` contra `https://alon.one/juegos/api`.
- Sincronización en directo con `itty-sockets` y fallback por polling a la API.
- QR y enlace compartible para entrar a una sala.
- Carga de preguntas desde:
  - `https://jalonsomerchan.github.io/trivial-db`
  - fallback: `https://raw.githubusercontent.com/jalonsomerchan/trivial-db/main`
- Filtros por categorías y dificultad.
- Vista optimizada para móvil.

## Modos de juego

1. **Trivial a todos**: todos responden la misma pregunta y suma quien acierte.
2. **Trivial normal**: la pregunta va dirigida solo a una persona.
3. **Trivial por equipos**: responde un equipo y cada acierto suma al jugador y al equipo.
4. **Trivial por equipos: la mayoría**: el equipo suma si la mayoría acierta.
5. **Trivial por equipos: confiamos en ti**: solo responde una persona del equipo.
6. **Lo sabe / no lo sabe**: una persona responde y el resto predice si la sabe o no la sabe.

## Opciones de sala

- Tiempo por pregunta.
- Número de rondas.
- Categorías.
- Dificultad.
- **No me lo sé**: permite pasar la pregunta a otra persona. Si el retado falla, puntúa doble quien pasó; si acierta, puntúa doble el retado.
- **El más rápido**: activa pulsador y solo responde quien pulse primero.
- **Admin lee**: el anfitrión ve la pregunta completa y los jugadores solo ven las opciones.

## Estructura

```txt
index.html
manifest.json
js/
  GameAPI.js
  notelasabes.js
```

## Despliegue

Es una web estática. Puedes subirla a GitHub Pages, Cloudflare Pages, Netlify o cualquier hosting estático.

No necesita build.
