const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

const FB_TOKEN = process.env.FB_TOKEN;
const YAMPI_ALIAS = process.env.YAMPI_ALIAS;
const YAMPI_TOKEN = process.env.YAMPI_TOKEN;
const YAMPI_SECRET = process.env.YAMPI_SECRET;

const CONTAS = [
  { id: 'act_1030253875028322', name: 'Gabriela Barbosa BM', usd: false, imposto_fb: true },
  { id: 'act_796659185083206',  name: 'Julia Sales',         usd: false, imposto_fb: true },
  { id: 'act_889783945836280',  name: 'Elisa Rezende',       usd: false, imposto_fb: true },
  { id: 'act_1183800759785720', name: 'Modalivio 03',        usd: false, imposto_fb: false },
  { id: 'act_171208025388700',  name: 'PF20 Gabriela BM',   usd: true,  imposto_fb: false },
  { id: 'act_3779787465666043', name: 'BMP - 01',            usd: true,  imposto_fb: false },
  { id: 'act_1687611685734606', name: 'BMP - 03',            usd: true,  imposto_fb: false },
  { id: 'act_860712357015194',  name: 'Modalivio 05',        usd: true,  imposto_fb: false },
  { id: 'act_904498949071872',  name: 'BMP - 02',            usd: true,  imposto_fb: false },
];

async function fetchFbAccount(accountId, from, to) {
  const fields = 'spend,impressions,clicks,cpm,ctr';
  const timeRange = JSON.stringify({ since: from, until: to });
  const url = `https://graph.facebook.com/v18.0/${accountId}/insights?fields=${fields}&time_range=${timeRange}&time_increment=1&access_token=${FB_TOKEN}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.data || [];
}

app.get('/api/facebook', async (req, res) => {
  try {
    const { from, to, cambio = 5.70, imposto_fb_pct = 3.68, contas_ativas } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'Informe from e to' });

    const cambiof = parseFloat(cambio);
    const impostoPct = parseFloat(imposto_fb_pct) / 100;
    const ativasList = contas_ativas ? contas_ativas.split(',') : CONTAS.map(c => c.id);
    const contasFiltradas = CONTAS.filter(c => ativasList.includes(c.id));
    const resultados = [];
    const evolucaoDiaria = {};

    for (const conta of contasFiltradas) {
      try {
        const dias = await fetchFbAccount(conta.id, from, to);
        let spendTotal = 0, impressoesTotal = 0, cliquesTotal = 0;

        for (const dia of dias) {
          const spendRaw = parseFloat(dia.spend || 0);
          const spendBrl = conta.usd ? spendRaw * cambiof : spendRaw;
          const imposto = conta.imposto_fb ? spendBrl * impostoPct : 0;
          const spendFinal = spendBrl + imposto;
          spendTotal += spendFinal;
          impressoesTotal += parseInt(dia.impressions || 0);
          cliquesTotal += parseInt(dia.clicks || 0);
          const date = dia.date_start;
          if (!evolucaoDiaria[date]) evolucaoDiaria[date] = { date, spend: 0 };
          evolucaoDiaria[date].spend += spendFinal;
        }

        resultados.push({ id: conta.id, name: conta.name, usd: conta.usd, imposto_fb: conta.imposto_fb, spend: spendTotal, impressions: impressoesTotal, clicks: cliquesTotal });
      } catch (e) {
        resultados.push({ id: conta.id, name: conta.name, spend: 0, error: e.message });
      }
    }

    res.json({
      contas: resultados,
      totais: {
        spend: resultados.reduce((s, c) => s + (c.spend || 0), 0),
        impressions: resultados.reduce((s, c) => s + (c.impressions || 0), 0),
        clicks: resultados.reduce((s, c) => s + (c.clicks || 0), 0),
      },
      evolucao: Object.values(evolucaoDiaria).sort((a, b) => a.date.localeCompare(b.date)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/yampi', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'Informe from e to' });

    let page = 1, totalPages = 1;
    const pedidos = [];

    while (page <= totalPages) {
      const params = new URLSearchParams({
        include: 'items',
        limit: '100',
        page: String(page),
      });
      params.append('q[created_at_gteq]', `${from} 00:00:00`);
      params.append('q[created_at_lteq]', `${to} 23:59:59`);
      const url = `https://api.dooki.com.br/v2/${YAMPI_ALIAS}/orders?${params.toString()}`;
      const r = await fetch(url, {
        headers: { 'User-Token': YAMPI_TOKEN, 'User-Secret-Key': YAMPI_SECRET, 'Content-Type': 'application/json' },
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || 'Erro Yampi');
      (data.data || []).forEach(p => pedidos.push(p));
      totalPages = data.meta?.pagination?.total_pages || 1;
      page++;
    }

    const aprovados = pedidos.filter(p => p.status && ['paid','approved','complete'].includes(p.status.alias));
    const cancelados = pedidos.filter(p => p.status && ['cancelled','canceled'].includes(p.status.alias));
    const somaReceita = arr => arr.reduce((s, p) => s + parseFloat(p.total || 0), 0);
    const receitaAprovada = somaReceita(aprovados);

    const evolucaoDiaria = {};
    aprovados.forEach(p => {
      const date = (p.created_at || '').slice(0, 10);
      if (!date) return;
      if (!evolucaoDiaria[date]) evolucaoDiaria[date] = { date, receita: 0, pedidos: 0 };
      evolucaoDiaria[date].receita += parseFloat(p.total || 0);
      evolucaoDiaria[date].pedidos += 1;
    });

    res.json({
      total_pedidos: pedidos.length,
      aprovados: { qtde: aprovados.length, receita: receitaAprovada },
      cancelados: { qtde: cancelados.length, receita: somaReceita(cancelados) },
      ticket_medio: aprovados.length > 0 ? receitaAprovada / aprovados.length : 0,
      evolucao: Object.values(evolucaoDiaria).sort((a, b) => a.date.localeCompare(b.date)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/contas', (req, res) => res.json(CONTAS));
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
