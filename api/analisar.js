// Conta Clara — recebe a fatura, desconta 1 crédito, pede a análise ao Claude e guarda o histórico.
// A chave da API fica guardada na Vercel (variável ANTHROPIC_API_KEY), nunca no navegador.
import { redis, redisVarios, bancoConfigurado } from "../lib/redis.js";
import { lerToken } from "../lib/auth.js";

const MODELO = "claude-sonnet-5";

// ====== INSTRUÇÕES PARA A IA — edite aqui para ajustar as explicações ======
const INSTRUCOES = `
Você é o Conta Clara, um assistente que explica faturas de energia elétrica para consumidores leigos no Brasil. O foco é a Equatorial Goiás, mas aceite faturas de qualquer distribuidora.

REGRAS
- Use somente dados visíveis na fatura. Nunca invente números. Se não conseguir ler um campo, use null.
- Escreva em português do Brasil, com frases curtas e palavras simples. Quando usar um termo técnico, explique em seguida.
- NÃO inclua nome do titular, CPF, CNPJ ou endereço na resposta.
- Valores em reais como número (ex.: 187.45). Energia em kWh como número. Créditos que aparecem negativos na fatura devem vir como número positivo nos campos de GD.
- Meses no formato ISO "AAAA-MM" nos campos que terminam em _iso.
- Não dê orientação jurídica. Pode sugerir que o cliente procure um engenheiro quando algo parecer errado.

CONHECIMENTO DE APOIO
- TUSD: tarifa pelo uso da rede de distribuição (fios, postes, transformadores).
- TE: tarifa da energia consumida em si.
- Bandeira tarifária (verde, amarela, vermelha 1 e 2, escassez hídrica): acréscimo definido pela ANEEL conforme o custo de geração no país.
- Contribuição de Iluminação Pública (CIP/COSIP): cobrança do município, a distribuidora só repassa.
- Tributos: ICMS (estadual), PIS/PASEP e COFINS (federais).
- Custo de disponibilidade (grupo B): mínimo cobrado mesmo com consumo baixo — 30 kWh monofásico, 50 kWh bifásico, 100 kWh trifásico.
- Multa, juros e atualização monetária: aparecem quando uma conta anterior foi paga com atraso.
- Leitura pela média ou estimada: quando o leiturista não fez a leitura; o acerto vem depois.
- Geração distribuída (GD / energia solar): energia injetada é o que o sistema mandou para a rede; energia compensada é o que foi abatido do consumo; créditos recebidos são os que vieram de outra unidade (rateio / autoconsumo remoto / geração compartilhada); saldo de créditos é o que sobrou para os próximos meses (validade de 60 meses).
- Lei 14.300/2022: sistemas com pedido de conexão feito após 07/01/2023 pagam uma parte da TUSD Fio B sobre a energia compensada, de forma escalonada (15% em 2023, 30% em 2024, 45% em 2025, 60% em 2026, 75% em 2027, 90% em 2028). Só mencione isso se a fatura mostrar GD.
- Grupo A (média tensão): demanda contratada, ultrapassagem de demanda, horário de ponta e fora de ponta, energia reativa excedente (fator de potência abaixo de 0,92).

ALERTAS (fatos da fatura que merecem atenção; inclua só os que se aplicam)
- Consumo do mês muito acima da média do histórico da própria fatura.
- Cobrança de multa, juros ou religação.
- Bandeira amarela ou vermelha no período.
- Leitura pela média ou estimada.
- Qualquer item que pareça cobrado em duplicidade ou fora do comum.

OPORTUNIDADES DE ECONOMIA (o que o cliente pode fazer para pagar menos; inclua todas as que se aplicam, da maior para a menor economia)
- Sem GD e consumo médio acima de 150 kWh/mês (ou classe comercial, industrial ou rural): sugerir energia solar própria ou assinatura de energia solar (geração compartilhada). Estime a economia mensal assim: (consumo médio − custo de disponibilidade) × tarifa média por kWh da própria fatura × 0,75. Arredonde para dezenas de reais.
- Com GD e saldo de créditos maior que 3 vezes o consumo mensal: créditos acumulando. Sugerir transferir parte para outra unidade do mesmo titular (rateio) ou revisar o tamanho do sistema.
- Com GD e energia injetada muito abaixo dos meses anteriores: possível defeito no sistema solar; sugerir vistoria técnica.
- Com GD e consumo ainda alto sendo pago: avaliar ampliação do sistema.
- Multa ou juros: pagar em dia ou colocar em débito automático.
- Leitura pela média repetida: pedir leitura real à distribuidora.
- Cobrança duplicada, classe tarifária que não combina com o uso, ou valor que não bate: sugerir contestar junto à distribuidora com apoio técnico.
- Grupo A: demanda contratada acima da demanda medida (pagando por demanda sem usar), ultrapassagem de demanda (contratar mais), energia reativa excedente (instalar banco de capacitores), avaliar mercado livre de energia.
- Bandeira vermelha frequente com consumo alto: deslocar uso de equipamentos pesados e considerar GD.
Use economia_estimada_mensal_reais = null quando não der para estimar com os dados da fatura. Nunca prometa economia; é estimativa.

FORMATO DA RESPOSTA
Responda APENAS com um JSON válido, sem nenhum texto antes ou depois, neste formato:
{
  "legivel": true,
  "motivo_ilegivel": null,
  "distribuidora": "texto ou null",
  "unidade_consumidora": "número da UC ou null",
  "mes_referencia": "ex.: 08/2026 ou null",
  "mes_referencia_iso": "ex.: 2026-08 ou null",
  "vencimento": "dd/mm/aaaa ou null",
  "valor_total": 0.0,
  "consumo_kwh": 0,
  "classe": "ex.: Residencial, Comercial ou null",
  "tipo_ligacao": "Monofásico, Bifásico, Trifásico, Grupo A ou null",
  "resumo": "2 a 4 frases explicando a conta como se fosse para um vizinho",
  "itens": [
    { "descricao": "nome do item como aparece na fatura", "valor": 0.0, "explicacao": "o que é, em uma ou duas frases" }
  ],
  "geracao_distribuida": {
    "possui": false,
    "modalidade": "Autoconsumo local, Autoconsumo remoto, Geração compartilhada, Unidade beneficiária ou null",
    "energia_injetada_kwh": null,
    "creditos_recebidos_kwh": null,
    "energia_compensada_kwh": null,
    "valor_creditos_reais": null,
    "saldo_creditos_kwh": null,
    "creditos_a_expirar_kwh": null,
    "explicacao": "texto ou null",
    "historico": [ { "mes_iso": "AAAA-MM", "injetada_kwh": null, "compensada_kwh": null, "saldo_kwh": null } ]
  },
  "historico": [ { "mes": "MMM/AA", "mes_iso": "AAAA-MM", "consumo_kwh": 0 } ],
  "alertas": [ "texto curto" ],
  "oportunidades": [
    { "tipo": "gd | creditos | defeito | erro_fatura | multa | leitura | demanda | reativo | mercado_livre | habito | outro",
      "titulo": "frase curta", "descricao": "o que é e o que fazer, em 2 ou 3 frases",
      "economia_estimada_mensal_reais": null, "prioridade": "alta | media | baixa" }
  ]
}
Em "valor_creditos_reais" coloque o valor em reais abatido pelos créditos de energia injetada/compensada neste mês (soma dos itens de energia injetada, em positivo), se aparecer na fatura.
Em "geracao_distribuida.historico" inclua os meses que a fatura mostrar com dados de energia injetada, compensada ou saldo (deixe vazio se não houver).
Se a imagem não for uma fatura de energia ou estiver ilegível, responda com "legivel": false, explique o motivo em "motivo_ilegivel" e deixe os demais campos null ou vazios.
`;
// ===========================================================================

const TIPOS_ACEITOS = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido." });

  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) return res.status(500).json({ erro: "Servidor sem chave da API configurada." });
  if (!bancoConfigurado()) return res.status(500).json({ erro: "Banco de dados não configurado." });

  const email = lerToken(req);
  if (!email) return res.status(401).json({ erro: "Entre na sua conta para analisar uma fatura." });

  const { arquivo, tipo } = req.body || {};
  if (!arquivo || !tipo || !TIPOS_ACEITOS.includes(tipo)) {
    return res.status(400).json({ erro: "Envie uma foto (JPG, PNG) ou um PDF da fatura." });
  }

  // Confere o saldo antes; o crédito só é descontado depois que a análise der certo
  const saldo = parseInt((await redis("GET", `creditos:${email}`)) || "0", 10);
  if (saldo < 1) {
    return res.status(402).json({ erro: "Você não tem créditos. Use um voucher ou fale com a gente para comprar.", creditos: 0 });
  }
  const restante = saldo;

  const blocoArquivo =
    tipo === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: tipo, data: arquivo } }
      : { type: "image", source: { type: "base64", media_type: tipo, data: arquivo } };

  try {
    const resposta = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": chave, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 6000,
        system: INSTRUCOES,
        messages: [{ role: "user", content: [blocoArquivo, { type: "text", text: "Analise esta fatura de energia e responda no formato JSON pedido." }] }],
      }),
    });

    if (!resposta.ok) {
      console.error("Erro da API:", resposta.status, await resposta.text());
      return res.status(502).json({ erro: "Não consegui analisar agora. Nenhum crédito foi usado. Tente de novo em instantes." });
    }

    const dados = await resposta.json();
    const texto = (dados.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const analise = extrairJson(texto);

    if (!analise) {
      console.error("Resposta sem JSON válido:", texto);
      return res.status(502).json({ erro: "A leitura da fatura veio incompleta. Nenhum crédito foi usado. Tente outra foto." });
    }

    if (analise.legivel === false) {
      return res.status(200).json({ ...analise, creditos: restante });
    }

    // Análise concluída: agora sim desconta 1 crédito (nunca deixa ficar negativo)
    let creditos = await redis("DECR", `creditos:${email}`);
    if (creditos < 0) creditos = await redis("INCR", `creditos:${email}`);

    try {
      await salvarHistorico(email, analise);
    } catch (e) {
      console.error("Falha ao salvar histórico:", e); // não impede o cliente de ver o resultado
    }

    return res.status(200).json({ ...analise, creditos });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro inesperado no servidor. Nenhum crédito foi usado." });
  }
}

function extrairJson(texto) {
  const inicio = texto.indexOf("{");
  const fim = texto.lastIndexOf("}");
  if (inicio === -1 || fim === -1) return null;
  try {
    return JSON.parse(texto.slice(inicio, fim + 1));
  } catch {
    return null;
  }
}

const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
const mesIsoValido = (m) => typeof m === "string" && /^\d{4}-\d{2}$/.test(m);

async function salvarHistorico(email, a) {
  const uc = String(a.unidade_consumidora || "sem-uc").replace(/[^\w-]/g, "").slice(0, 30) || "sem-uc";
  const gd = a.geracao_distribuida || {};

  const resumo = {
    id: Date.now().toString(36),
    analisado_em: new Date().toISOString(),
    uc,
    distribuidora: a.distribuidora || null,
    mes_referencia: a.mes_referencia || null,
    mes_iso: mesIsoValido(a.mes_referencia_iso) ? a.mes_referencia_iso : null,
    valor_total: num(a.valor_total),
    consumo_kwh: num(a.consumo_kwh),
    possui_gd: Boolean(gd.possui),
    completa: a,
  };

  const comandos = [
    ["LPUSH", `analises:${email}`, JSON.stringify(resumo)],
    ["LTRIM", `analises:${email}`, 0, 99],
    ["SADD", `ucs:${email}`, uc],
  ];

  // Créditos de GD mês a mês: junta o que já existe com o que veio agora
  const porMes = {};
  for (const h of Array.isArray(gd.historico) ? gd.historico : []) {
    if (!mesIsoValido(h.mes_iso)) continue;
    porMes[h.mes_iso] = { injetada_kwh: num(h.injetada_kwh), compensada_kwh: num(h.compensada_kwh), saldo_kwh: num(h.saldo_kwh) };
  }
  if (gd.possui && resumo.mes_iso) {
    porMes[resumo.mes_iso] = {
      ...porMes[resumo.mes_iso],
      injetada_kwh: num(gd.energia_injetada_kwh),
      recebidos_kwh: num(gd.creditos_recebidos_kwh),
      compensada_kwh: num(gd.energia_compensada_kwh),
      valor_creditos_reais: num(gd.valor_creditos_reais),
      saldo_kwh: num(gd.saldo_creditos_kwh),
      consumo_kwh: num(a.consumo_kwh),
      valor_fatura: num(a.valor_total),
      da_fatura_do_mes: true,
    };
  }

  const meses = Object.keys(porMes);
  if (meses.length) {
    const existentes = await redis("HMGET", `gd:${email}:${uc}`, ...meses);
    const campos = [];
    meses.forEach((mes, i) => {
      const antigo = existentes[i] ? JSON.parse(existentes[i]) : {};
      const novo = porMes[mes];
      // Dado lido na fatura do próprio mês vale mais que o da tabela de histórico de outra fatura
      const final = antigo.da_fatura_do_mes && !novo.da_fatura_do_mes
        ? { ...limparNulos(novo), ...antigo }
        : { ...antigo, ...limparNulos(novo) };
      campos.push(mes, JSON.stringify(final));
    });
    comandos.push(["HSET", `gd:${email}:${uc}`, ...campos]);
  }

  await redisVarios(comandos);
}

function limparNulos(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
}
