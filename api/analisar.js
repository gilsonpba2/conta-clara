// Conta Clara — função de servidor que recebe a fatura e pede a análise ao Claude.
// A chave da API fica guardada na Vercel (variável ANTHROPIC_API_KEY), nunca no navegador.

const MODELO = "claude-sonnet-5";

// ====== INSTRUÇÕES PARA A IA — edite aqui para ajustar as explicações ======
const INSTRUCOES = `
Você é o Conta Clara, um assistente que explica faturas de energia elétrica para consumidores leigos no Brasil. O foco é a Equatorial Goiás, mas aceite faturas de qualquer distribuidora.

REGRAS
- Use somente dados visíveis na fatura. Nunca invente números. Se não conseguir ler um campo, use null.
- Escreva em português do Brasil, com frases curtas e palavras simples. Quando usar um termo técnico, explique em seguida.
- NÃO inclua nome do titular, CPF, CNPJ ou endereço na resposta.
- Valores em reais como número (ex.: 187.45). Energia em kWh como número.
- Não dê orientação jurídica. Pode sugerir que o cliente procure a distribuidora ou um engenheiro quando algo parecer errado.

CONHECIMENTO DE APOIO
- TUSD: tarifa pelo uso da rede de distribuição (fios, postes, transformadores).
- TE: tarifa da energia consumida em si.
- Bandeira tarifária (verde, amarela, vermelha 1 e 2, escassez hídrica): acréscimo definido pela ANEEL conforme o custo de geração no país.
- Contribuição de Iluminação Pública (CIP/COSIP): cobrança do município, a distribuidora só repassa.
- Tributos: ICMS (estadual), PIS/PASEP e COFINS (federais).
- Custo de disponibilidade (grupo B): mínimo cobrado mesmo com consumo baixo — 30 kWh monofásico, 50 kWh bifásico, 100 kWh trifásico.
- Multa, juros e atualização monetária: aparecem quando uma conta anterior foi paga com atraso.
- Geração distribuída (GD / energia solar): energia injetada é o que o sistema mandou para a rede; energia compensada é o que foi abatido do consumo; saldo de créditos é o que sobrou para os próximos meses (validade de 60 meses). Pode haver rateio de créditos entre unidades (autoconsumo remoto).
- Lei 14.300/2022: sistemas com pedido de conexão feito após 07/01/2023 pagam uma parte da TUSD Fio B sobre a energia compensada, de forma escalonada (15% em 2023, 30% em 2024, 45% em 2025, 60% em 2026, 75% em 2027, 90% em 2028). Só mencione isso se a fatura mostrar GD.
- Grupo A (média tensão): demanda contratada, ultrapassagem de demanda, horário de ponta e fora de ponta, energia reativa excedente (fator de potência abaixo de 0,92).

ALERTAS (inclua só os que se aplicam)
- Consumo do mês muito acima da média do histórico da própria fatura.
- Cobrança de multa, juros ou religação.
- Bandeira amarela ou vermelha no período.
- Saldo de créditos de GD alto e parado, ou energia injetada bem menor que o normal.
- Qualquer item que pareça cobrado em duplicidade ou fora do comum.

FORMATO DA RESPOSTA
Responda APENAS com um JSON válido, sem nenhum texto antes ou depois, neste formato:
{
  "legivel": true,
  "motivo_ilegivel": null,
  "distribuidora": "texto ou null",
  "unidade_consumidora": "texto ou null",
  "mes_referencia": "ex.: 08/2026 ou null",
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
    "energia_injetada_kwh": null,
    "energia_compensada_kwh": null,
    "saldo_creditos_kwh": null,
    "explicacao": "texto ou null"
  },
  "historico": [ { "mes": "MMM/AA", "consumo_kwh": 0 } ],
  "alertas": [ "texto curto" ]
}
Se a imagem não for uma fatura de energia ou estiver ilegível, responda com "legivel": false, explique o motivo em "motivo_ilegivel" e deixe os demais campos null ou vazios.
`;
// ===========================================================================

const TIPOS_ACEITOS = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ erro: "Método não permitido." });
  }

  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) {
    return res.status(500).json({ erro: "Servidor sem chave da API configurada." });
  }

  // Código de acesso opcional (variável CODIGO_ACESSO na Vercel)
  const codigoEsperado = process.env.CODIGO_ACESSO;
  const { arquivo, tipo, codigo } = req.body || {};
  if (codigoEsperado && codigo !== codigoEsperado) {
    return res.status(401).json({ erro: "Código de acesso inválido." });
  }

  if (!arquivo || !tipo || !TIPOS_ACEITOS.includes(tipo)) {
    return res.status(400).json({ erro: "Envie uma foto (JPG, PNG) ou um PDF da fatura." });
  }

  const blocoArquivo =
    tipo === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: tipo, data: arquivo } }
      : { type: "image", source: { type: "base64", media_type: tipo, data: arquivo } };

  try {
    const resposta = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": chave,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 4000,
        system: INSTRUCOES,
        messages: [
          {
            role: "user",
            content: [blocoArquivo, { type: "text", text: "Analise esta fatura de energia e responda no formato JSON pedido." }],
          },
        ],
      }),
    });

    if (!resposta.ok) {
      const detalhe = await resposta.text();
      console.error("Erro da API:", resposta.status, detalhe);
      return res.status(502).json({ erro: "Não consegui analisar agora. Tente de novo em instantes." });
    }

    const dados = await resposta.json();
    const texto = (dados.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const analise = extrairJson(texto);

    if (!analise) {
      console.error("Resposta sem JSON válido:", texto);
      return res.status(502).json({ erro: "A leitura da fatura veio incompleta. Tente outra foto." });
    }

    return res.status(200).json(analise);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro inesperado no servidor." });
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
