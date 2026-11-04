"use strict";

/*
 * Front de chat (PRD §6.1). Solo presenta: ninguna clave ni regla de negocio vive aquí.
 * Todo texto del modelo se inserta con textContent y nodos DOM, nunca como HTML crudo.
 */

/** Prompt de ejemplo del PRD §11, literal (una prueba compara este texto contra PRD.md). */
const PROMPT_PRD =
  "Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que esté limpio, muéstrame lo que requiere revisión campo por campo y termina con el reporte de alertas. No registres nada dudoso sin preguntarme.";

const CLAVE_SESION = "reto02.sessionId";
const ID_VALIDO = /^[\w-]{6,64}$/;
const MSG_RED = "No pude contactar con el servidor. Revisa tu conexión y vuelve a intentarlo; la conversación no se perdió.";
const MSG_CORTE =
  "Se perdió la conexión mientras el agente trabajaba. El servidor termina el turno aunque cierres la página: espera unos segundos y recarga para ver el resultado.";

const $ = (id) => document.getElementById(id);
const el = {
  chat: $("chat"),
  formulario: $("formulario"),
  entrada: $("entrada"),
  enviar: $("btn-enviar"),
  ejemplo: $("btn-ejemplo"),
  reiniciar: $("btn-reiniciar"),
  aviso: $("aviso-confirmacion"),
  avisoDetalle: $("aviso-detalle"),
  confirmo: $("btn-confirmo"),
  modelo: $("estado-modelo"),
};

/** Estado de la página: id de sesión (también en memoria por si localStorage falla), turno en curso y nodos vivos. */
const estado = { id: null, ocupado: false, pensando: null, bienvenida: null };

// ── Utilidades de DOM ──

function crear(etiqueta, clase, texto) {
  const nodo = document.createElement(etiqueta);
  if (clase) nodo.className = clase;
  if (texto !== undefined) nodo.textContent = texto;
  return nodo;
}

function estaAbajo() {
  return el.chat.scrollHeight - el.chat.scrollTop - el.chat.clientHeight < 140;
}

/** Agrega un nodo al chat (antes del indicador de «pensando») y sigue el final si el usuario ya estaba abajo. */
function agregar(nodo, forzarBajar = false) {
  const bajar = forzarBajar || estaAbajo();
  el.chat.insertBefore(nodo, estado.pensando);
  if (bajar) el.chat.scrollTop = el.chat.scrollHeight;
  return nodo;
}

// ── Sesión: localStorage siempre dentro de try/catch (puede estar bloqueado) ──

function leerIdGuardado() {
  try {
    const guardado = localStorage.getItem(CLAVE_SESION);
    return guardado && ID_VALIDO.test(guardado) ? guardado : null;
  } catch {
    return null;
  }
}

function guardarId(id) {
  try {
    localStorage.setItem(CLAVE_SESION, id);
  } catch {
    // Sin almacenamiento: la sesión vive solo mientras la página siga abierta.
  }
}

function olvidarId() {
  try {
    localStorage.removeItem(CLAVE_SESION);
  } catch {
    // Nada que borrar.
  }
}

/** randomUUID solo existe en contextos seguros (https/localhost); en http por red local se arma con getRandomValues. */
function nuevoId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function obtenerSessionId() {
  if (!estado.id) estado.id = leerIdGuardado();
  if (!estado.id) {
    estado.id = nuevoId();
    guardarId(estado.id);
  }
  return estado.id;
}

// ── Markdown mínimo → DOM (negritas, código, listas, tablas, encabezados) ──

function inline(padre, texto) {
  texto.split(/(\*\*[^*]+\*\*|`[^`]+`)/).forEach((trozo, i) => {
    if (!trozo) return;
    if (i % 2 === 0) padre.append(trozo);
    else if (trozo.startsWith("**")) padre.append(crear("strong", "", trozo.slice(2, -2)));
    else padre.append(crear("code", "", trozo.slice(1, -1)));
  });
}

const SEPARADOR_TABLA = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const ES_ITEM = /^\s*([-*]|\d+\.)\s+/;
const ES_ENCABEZADO = /^#{1,4}\s/;

const esTabla = (lineas, i) => lineas[i].includes("|") && SEPARADOR_TABLA.test(lineas[i + 1] ?? "");
const iniciaBloque = (lineas, i) =>
  lineas[i].trim().startsWith("```") || ES_ITEM.test(lineas[i]) || ES_ENCABEZADO.test(lineas[i]) || esTabla(lineas, i);

const celdas = (linea) =>
  linea.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function bloqueCodigo(raiz, lineas, i) {
  const codigo = [];
  let j = i + 1;
  while (j < lineas.length && !lineas[j].trim().startsWith("```")) codigo.push(lineas[j++]);
  const pre = crear("pre");
  pre.append(crear("code", "", codigo.join("\n")));
  raiz.append(pre);
  return j + 1;
}

function tabla(raiz, lineas, i) {
  const t = crear("table");
  const cabecera = crear("tr");
  celdas(lineas[i]).forEach((c) => {
    const th = crear("th");
    inline(th, c);
    cabecera.append(th);
  });
  t.append(cabecera);
  let j = i + 2;
  while (j < lineas.length && lineas[j].includes("|") && lineas[j].trim()) {
    const fila = crear("tr");
    celdas(lineas[j++]).forEach((c) => {
      const td = crear("td");
      inline(td, c);
      fila.append(td);
    });
    t.append(fila);
  }
  const envoltorio = crear("div", "tabla-envoltorio");
  envoltorio.append(t);
  raiz.append(envoltorio);
  return j;
}

function lista(raiz, lineas, i) {
  const ordenada = /^\s*\d+\./.test(lineas[i]);
  const ul = crear(ordenada ? "ol" : "ul");
  let j = i;
  while (j < lineas.length && ES_ITEM.test(lineas[j])) {
    const li = crear("li");
    inline(li, lineas[j++].replace(ES_ITEM, ""));
    ul.append(li);
  }
  raiz.append(ul);
  return j;
}

function parrafo(raiz, lineas, i) {
  const p = crear("p");
  let j = i;
  while (j < lineas.length && lineas[j].trim() && (j === i || !iniciaBloque(lineas, j))) {
    if (j > i) p.append(document.createElement("br"));
    inline(p, lineas[j++]);
  }
  raiz.append(p);
  return j;
}

function renderMarkdown(texto) {
  const raiz = document.createDocumentFragment();
  const lineas = texto.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lineas.length) {
    const linea = lineas[i];
    if (linea.trim().startsWith("```")) i = bloqueCodigo(raiz, lineas, i);
    else if (esTabla(lineas, i)) i = tabla(raiz, lineas, i);
    else if (ES_ITEM.test(linea)) i = lista(raiz, lineas, i);
    else if (ES_ENCABEZADO.test(linea)) {
      raiz.append(crear("h4", "", linea.replace(/^#+\s*/, "")));
      i++;
    } else if (!linea.trim()) i++;
    else i = parrafo(raiz, lineas, i);
  }
  return raiz;
}

// ── Burbujas, indicador y tarjetas ──

function burbujaUsuario(texto) {
  return crear("div", "burbuja usuario", texto);
}

function burbujaAgente(texto) {
  const b = crear("div", "burbuja agente");
  b.append(renderMarkdown(texto));
  return b;
}

/** Errores (CA5): siempre en lenguaje claro dentro del chat. */
function burbujaError(texto) {
  return crear("div", "burbuja error", texto);
}

function mostrarBienvenida() {
  if (estado.bienvenida) return;
  estado.bienvenida = crear(
    "div",
    "burbuja sistema",
    "Soy el agente de registro de contratos. Escribe «procesa el buzón» o usa «Ejemplo del PRD §11» para rellenar el prompt de la demo. No registro nada dudoso sin tu confirmación.",
  );
  agregar(estado.bienvenida);
}

function quitarBienvenida() {
  estado.bienvenida?.remove();
  estado.bienvenida = null;
}

function mostrarPensando(texto) {
  if (!estado.pensando) {
    estado.pensando = crear("div", "pensando");
    const puntos = crear("span", "puntos");
    puntos.append(crear("span"), crear("span"), crear("span"));
    estado.pensando.append(puntos, crear("span", "texto-pensando"));
    el.chat.append(estado.pensando);
  }
  estado.pensando.querySelector(".texto-pensando").textContent = texto;
  el.chat.scrollTop = el.chat.scrollHeight;
}

function quitarPensando() {
  estado.pensando?.remove();
  estado.pensando = null;
}

const jsonLegible = (valor) => JSON.stringify(valor ?? {}, null, 2);

/** Tarjeta plegable de una llamada a herramienta (PRD §6.1, CA4): nombre, argumentos y resultado resumido. */
function crearTarjeta(nombre, argumentos) {
  const nodo = crear("details", "herramienta corriendo");
  const resumen = crear("summary");
  const marca = crear("span", "estado", "ejecutando…");
  const corto = crear("span", "corto");
  resumen.append(crear("span", "nombre", nombre), marca, corto);
  const detalle = crear("div", "detalle");
  const args = crear("pre", "", jsonLegible(argumentos));
  const resultado = crear("p", "resultado", "Esperando el resultado…");
  detalle.append(crear("h5", "", "Argumentos"), args, crear("h5", "", "Resultado"), resultado);
  nodo.append(resumen, detalle);
  const completar = (ok, texto) => {
    nodo.className = `herramienta ${ok ? "ok" : "fallo"}`;
    marca.textContent = ok ? "ok" : "error";
    corto.textContent = texto;
    resultado.textContent = texto;
  };
  return { nodo, completar };
}

function pintarLlamadas(llamadas) {
  for (const l of llamadas) {
    const t = crearTarjeta(l.nombre, l.argumentos);
    t.completar(l.ok, l.resumen);
    agregar(t.nodo);
  }
}

// ── Aviso de confirmación (CA3) ──

function mostrarAviso(pendientes) {
  const lista = pendientes.length > 0 ? `Mensajes en revisión: ${pendientes.join(", ")}. ` : "Hay una revisión pendiente. ";
  el.avisoDetalle.textContent = `${lista}Escribe lo que confirmas después de «Confirmo » y envíalo: el agente no registra nada sin tu mensaje.`;
  el.aviso.hidden = false;
  el.chat.scrollTop = el.chat.scrollHeight;
}

function ocultarAviso() {
  el.aviso.hidden = true;
}

// ── Turno en vivo (stream SSE por POST) ──

function nuevoTurno() {
  return { tarjetas: new Map(), ultimo: "", ultimaBurbuja: null, fin: false, conEventos: false };
}

/** Cierra el turno con el `ResultadoTurno`: completa la respuesta si no salió ya por eventos y resalta la confirmación. */
function cerrarTurno(turno, resultado) {
  turno.fin = true;
  if (resultado.reply && resultado.reply !== turno.ultimo) {
    turno.ultimaBurbuja = agregar(burbujaAgente(resultado.reply));
  }
  if (resultado.needsConfirmation) {
    turno.ultimaBurbuja?.classList.add("pide-confirmacion");
    mostrarAviso(resultado.pendientes ?? []);
  }
  if (resultado.aviso) agregar(crear("div", "burbuja aviso", resultado.aviso));
}

function alHerramienta(turno, d) {
  const t = crearTarjeta(d.nombre, d.argumentos);
  turno.tarjetas.set(d.id, t);
  agregar(t.nodo);
  mostrarPensando(`Ejecutando ${d.nombre}…`);
}

function alEvento(turno, { nombre, datos }) {
  turno.conEventos = true;
  if (nombre === "texto") {
    turno.ultimo = datos.texto;
    turno.ultimaBurbuja = agregar(burbujaAgente(datos.texto));
  } else if (nombre === "herramienta") alHerramienta(turno, datos);
  else if (nombre === "resultado") {
    turno.tarjetas.get(datos.id)?.completar(datos.ok, datos.resumen);
    mostrarPensando("Pensando…");
  } else if (nombre === "error") {
    turno.ultimo = datos.mensaje;
    agregar(burbujaError(datos.mensaje));
  } else if (nombre === "fin") cerrarTurno(turno, datos);
}

/** Una trama SSE (`event:` + `data:`); los comentarios `: latido` se ignoran. */
function parsearTrama(trama) {
  let nombre = "message";
  let datos = "";
  for (const linea of trama.split("\n")) {
    if (linea.startsWith("event:")) nombre = linea.slice(6).trim();
    else if (linea.startsWith("data:")) datos += linea.slice(5).trim();
  }
  if (!datos) return null;
  try {
    return { nombre, datos: JSON.parse(datos) };
  } catch {
    return null;
  }
}

/** EventSource solo hace GET; para un POST se lee el cuerpo como stream y se corta por la línea en blanco de cada trama. */
async function leerStream(respuesta, alRecibir) {
  const lector = respuesta.body.getReader();
  const decodificador = new TextDecoder();
  let resto = "";
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    resto += decodificador.decode(value, { stream: true });
    const tramas = resto.split("\n\n");
    resto = tramas.pop();
    for (const trama of tramas) {
      const evento = parsearTrama(trama);
      if (evento) alRecibir(evento);
    }
  }
}

async function textoDeErrorHttp(respuesta) {
  try {
    const cuerpo = await respuesta.json();
    if (cuerpo && typeof cuerpo.error === "string") return cuerpo.error;
  } catch {
    // Cuerpo que no es JSON: se usa el mensaje genérico.
  }
  return `El servidor respondió con un error (${respuesta.status}). Vuelve a intentarlo.`;
}

async function procesarRespuesta(respuesta, turno, texto) {
  if (!respuesta.ok) {
    agregar(burbujaError(await textoDeErrorHttp(respuesta)));
    if (!el.entrada.value) el.entrada.value = texto;
  } else if ((respuesta.headers.get("content-type") ?? "").includes("text/event-stream")) {
    await leerStream(respuesta, (evento) => alEvento(turno, evento));
    if (!turno.fin) agregar(burbujaError(MSG_CORTE));
  } else {
    const resultado = await respuesta.json();
    pintarLlamadas(resultado.toolCalls ?? []);
    cerrarTurno(turno, resultado);
  }
}

function fijarOcupado(ocupado) {
  estado.ocupado = ocupado;
  el.enviar.disabled = ocupado;
  el.reiniciar.disabled = ocupado;
}

async function enviar(texto) {
  fijarOcupado(true);
  ocultarAviso();
  quitarBienvenida();
  agregar(burbujaUsuario(texto), true);
  mostrarPensando("Pensando…");
  const turno = nuevoTurno();
  try {
    const respuesta = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ sessionId: obtenerSessionId(), message: texto }),
    });
    await procesarRespuesta(respuesta, turno, texto);
  } catch {
    agregar(burbujaError(turno.conEventos ? MSG_CORTE : MSG_RED));
  } finally {
    quitarPensando();
    fijarOcupado(false);
    el.entrada.focus();
  }
}

// ── Reinicio y reconstrucción al recargar ──

function limpiarChat() {
  quitarPensando();
  estado.bienvenida = null;
  el.chat.replaceChildren();
}

async function reiniciarDemo() {
  if (estado.ocupado) return;
  if (!confirm("Esto borra la conversación y todo lo generado en out/ (maestro, archivo y log). ¿Reiniciar la demo?")) return;
  try {
    const respuesta = await fetch("/api/reset", { method: "POST" });
    if (!respuesta.ok) {
      agregar(burbujaError(await textoDeErrorHttp(respuesta)), true);
      return;
    }
    estado.id = null;
    olvidarId();
    limpiarChat();
    ocultarAviso();
    mostrarBienvenida();
  } catch {
    agregar(burbujaError(MSG_RED), true);
  }
}

function pintarSesion(sesion) {
  if (sesion.turnos.length === 0) return mostrarBienvenida();
  for (const t of sesion.turnos) {
    agregar(burbujaUsuario(t.usuario));
    pintarLlamadas(t.toolCalls);
    const burbuja = t.reply ? agregar(burbujaAgente(t.reply)) : null;
    if (t === sesion.turnos.at(-1) && t.needsConfirmation) {
      burbuja?.classList.add("pide-confirmacion");
      mostrarAviso(t.pendientes ?? []);
    }
  }
  el.chat.scrollTop = el.chat.scrollHeight;
}

async function restaurar() {
  const id = leerIdGuardado();
  if (!id) return mostrarBienvenida();
  try {
    const respuesta = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
    if (respuesta.status === 404) return mostrarBienvenida();
    if (!respuesta.ok) throw new Error("sesión no disponible");
    estado.id = id;
    pintarSesion(await respuesta.json());
  } catch {
    mostrarBienvenida();
    agregar(burbujaError("No pude recuperar la conversación anterior. Puedes seguir escribiendo."));
  }
}

async function mostrarModelo() {
  try {
    const respuesta = await fetch("/api/health");
    const salud = await respuesta.json();
    el.modelo.textContent = `${salud.provider} · ${salud.model}`;
  } catch {
    el.modelo.textContent = "Sin conexión con el servidor";
  }
}

// ── Entrada ──

function ajustarAltura() {
  el.entrada.style.height = "auto";
  el.entrada.style.height = `${el.entrada.scrollHeight}px`;
}

function prellenar(texto) {
  el.entrada.value = texto;
  ajustarAltura();
  el.entrada.focus();
  el.entrada.setSelectionRange(texto.length, texto.length);
}

el.formulario.addEventListener("submit", (e) => {
  e.preventDefault();
  const texto = el.entrada.value.trim();
  if (!texto || estado.ocupado) return;
  el.entrada.value = "";
  ajustarAltura();
  enviar(texto);
});

el.entrada.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    el.formulario.requestSubmit();
  }
});
el.entrada.addEventListener("input", ajustarAltura);
el.ejemplo.addEventListener("click", () => prellenar(PROMPT_PRD));
el.confirmo.addEventListener("click", () => prellenar("Confirmo "));
el.reiniciar.addEventListener("click", reiniciarDemo);

mostrarModelo();
restaurar();
