# Boost — Dark Mode Engine

Tutto il codice vive in `Boost Extension/Resources/content.js`. Niente Swift, niente popup logic.

## Perché questo approccio

Safari Web Extensions non può patchare il motore di rendering come fa Zen Browser sul renderer di Firefox. Quindi simuliamo "smart invert" via CSS, con una **filter chain** su `<html>` e una serie di **eccezioni mirate** che counter-invertono ciò che NON dovrebbe essere flippato.

L'alternativa (riscrittura per-color degli stylesheet stile Dark Reader) è stata implementata e poi rimossa: troppi edge case su CSS custom properties, cross-origin sheets, color-mix, oklch, ecc. Il filter+exceptions è più rozzo ma più affidabile.

## Pipeline CSS (cosa viene emesso in `boost-injected-style`)

Quando `boost.darkMode === true` e `boost.enabled !== false`, `buildCSS()` emette nell'ordine:

```css
:root { color-scheme: dark !important; }
html { filter: invert(1) hue-rotate(180deg) !important; }

/* media counter-invert (preserva colori originali) */
img, video, iframe, embed, object, svg image {
    filter: invert(1) hue-rotate(180deg) !important;
}

/* Point 2: img in UI regions opt-OUT del counter-invert
   (i logo si invertono col chrome → restano leggibili) */
:is(header, nav, footer, aside,
    [role="navigation"], [role="banner"],
    [role="contentinfo"], [role="complementary"]) :is(img, svg image) {
    filter: none !important;
}

/* Large img exception: img ≥200px in UI regions tornano
   counter-invertite (hero banner preservati) */
:is(...UI_REGIONS...) img[data-boost-large="true"] {
    filter: invert(1) hue-rotate(180deg) !important;
}

/* Point A: dark chrome counter-invertito → resta scuro */
[data-boost-dark="true"] {
    filter: invert(1) hue-rotate(180deg) !important;
}

/* Video container exclusive: counter-invert al wrapper invece
   che al <video> (fix Safari hardware decode bypass) */
[data-boost-video-container="true"] {
    filter: invert(1) hue-rotate(180deg) !important;
}
[data-boost-video-container="true"] > video {
    filter: none !important;
}
```

**Perché `picture` e `canvas` NON sono nel counter-invert**:
- `<picture>` wrappa `<img>` con un layer suo; counter-invertirli entrambi causa double-invert sul bitmap (stacking context).
- `<canvas>` è spesso usato come UI/grafico (chart, controlli, dashboard), per cui ha più senso che inverta col resto della pagina.

## Tag dinamici (JS-driven)

Tre passe di tagging girano in parallelo, tutte legate alla lifecycle del dark mode:

### 1. `tagDarkUiElements()` → Point A v2

Per ogni `:is(header, nav, footer, aside, [role=...])`:

1. **Walk-up**: sale sui parent finché trova background scuri (luminanza WCAG sRGB < 0.35), memorizzando ogni candidato. Stop alla prima resistenza opaca-chiara, a `<body>`, o a `<html>`. Transparent ancestors → no opinion, continua a salire.
2. **Outermost candidate**: l'elemento più alto trovato in catena ininterrotta di scuri.
3. **Content wrapper validation** (`boostIsContentWrapper`): se il candidato contiene `<main>`, `<article>`, `<video>`, 2+ immagini ≥200px, o supera il 60% dell'altezza viewport → è un'area di contenuto, non chrome → **scarta**.
4. **Fallback**: se l'outermost è stato scartato, tagga l'elemento semantico originale solo se *lui stesso* è scuro.
5. Set `data-boost-dark="true"` sull'elemento finale.

**Esempio Wired** (`<div class="footer-bg" bg=dark><footer bg=dark>...</footer></div>`): walk dal footer trova `div.footer-bg` come outermost. Il div non contiene main/article/video/molte immagini → tag del wrapper full-width → niente bordi laterali bianchi.

**Esempio dark-main page** (`<main bg=dark><article>...</article><footer></footer></main>`): walk dal footer trova `<main>` come outermost. `<main>` contiene `<article>` → scartato. Fallback al `<footer>` semantico → main resta invertita (dark mode applicata al contenuto), footer counter-invertito.

### 2. `tagLargeUiImages()`

Per ogni `:is(UI_REGIONS) img`:
- Se caricata (`img.complete && naturalWidth > 0`): misura via `getBoundingClientRect()` (con fallback a `naturalWidth/Height`).
- Se non caricata: registra listener `load` once-per-img (tracciato in `boostLoadAttachedImgs` WeakSet) e misura al caricamento.
- Tag `data-boost-large="true"` se width *o* height ≥ 200px (`BOOST_LARGE_IMG_THRESHOLD`).

Soglia bassa-conservativa: meglio falso-positivo "questo logo largo viene preservato originale" che falso-negativo "questa hero photo viene invertita".

### 3. `tagVideoContainers()`

Per ogni `<video>`:
- Trova `parentElement`.
- Skip se parent è `<body>`/`<html>` (taggare body neutralizzerebbe dark mode).
- Controlla esclusività: `Array.from(parent.children).every(c => VIDEO|SOURCE|TRACK)`.
- Se esclusivo (parent esiste solo per ospitare il video, es. `<div class="html5-video-container">`) → tag.

Lo scope esclusivo evita di counter-invertire articoli interi solo perché contengono un `<video>` inline (in quel caso si cade sul counter-invert del `<video>` come fallback, anche se su Safari il filter sul video element non sempre attecchisce per via dell'hardware decode).

## Lifecycle

Tutto è gated da `boost.darkMode && boost.enabled !== false`:

- **On**: `startDarkUiTracking()` chiama subito le 3 tag functions (o aspetta `DOMContentLoaded` se body non c'è), poi attiva un `MutationObserver(document.documentElement, {childList, subtree})` che richiama un retag throttled a 250ms (`boostScheduleDarkUiRetag`).
- **Off**: `stopDarkUiTracking()` disconnette l'observer, cancella il timer, rimuove i 3 listener `DOMContentLoaded`, e fa untag di tutto.

L'observer non guarda `attributes`, quindi i nostri stessi `setAttribute` non scatenano loop.

## Quirk noti / trade-off accettati

- **Cross-origin iframes**: il content script non gira dentro (`all_frames: false`). Iframe vengono counter-invertiti come "block" via la regola sui `iframe`, ma il loro contenuto interno non è raggiungibile.
- **Background-image CSS**: il filter di `<html>` inverte qualsiasi `background-image: url(...)` (anche foto). Non lo intercettiamo — è il prezzo della semplicità. Si vedono per esempio in pagine con foto come bg-image (rare in siti moderni).
- **Sito già dark di suo**: applicare il nostro dark mode flippa il sito a light. Non c'è auto-detect; sta all'utente non attivarlo lì.
- **`<video>` con HDR / filter di pagina**: la composizione di filtri nested può non cancellare matematicamente. Per questo il video container preferisce taggare il wrapper.

## Settings dell'utente (per riferimento)

Il `boost` object salvato in `browser.storage.local[hostname]` contiene:
- `enabled`, `darkMode`, `colorEnabled` (toggle master)
- `hueRotate, brightness, saturation, contrast` (filter chain extras quando `colorEnabled`)
- `fontIndex, textCase, textSize` (typography)
- `zapSelectors, zapsEnabled` (element hiding)
- `customCSS, customEnabled` (free-form override)
- `name` (label per host)

Tutto il resto (color picker 2D, dark engine "Dark Reader-lite") è stato rimosso nella riscrittura del 2026-05.
