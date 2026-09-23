// Acesso ao banco Upstash Redis pela API REST (sem instalar pacotes).
// A Vercel cria as variáveis automaticamente ao conectar o banco ao projeto.

const URL_BASE = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export function bancoConfigurado() {
  return Boolean(URL_BASE && TOKEN);
}

// Executa um comando: redis("SET", "chave", "valor")
export async function redis(...comando) {
  const r = await fetch(URL_BASE, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(comando.map(String)),
  });
  const dados = await r.json();
  if (dados.error) throw new Error("Redis: " + dados.error);
  return dados.result;
}

// Executa vários comandos numa ida só
export async function redisVarios(comandos) {
  const r = await fetch(URL_BASE.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(comandos.map((c) => c.map(String))),
  });
  const dados = await r.json();
  return dados.map((d) => {
    if (d.error) throw new Error("Redis: " + d.error);
    return d.result;
  });
}

// HGETALL devolve [campo, valor, campo, valor...] — converte para objeto
export function paraObjeto(lista) {
  if (!lista || !lista.length) return null;
  const o = {};
  for (let i = 0; i < lista.length; i += 2) o[lista[i]] = lista[i + 1];
  return o;
}
