const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

const SIGILO_PUBLIC = process.env.SIGILO_PUBLIC;
const SIGILO_SECRET = process.env.SIGILO_SECRET;
const SIGILO_URL = process.env.SIGILO_URL;
const FIREBASE_URL = process.env.FIREBASE_URL || 'https://zkn-ss-default-rtdb.firebaseio.com';
const PORT = process.env.PORT || 3000;

const sigiloHeaders = {
  'x-public-key': SIGILO_PUBLIC,
  'x-secret-key': SIGILO_SECRET,
  'Content-Type': 'application/json'
};

// ============================================================
// PING
// ============================================================
app.get('/api/ping', async (req, res) => {
  try {
    const response = await axios.get(`${SIGILO_URL}/ping`, { headers: sigiloHeaders });
    res.json({ sucesso: true, status: response.status, data: response.data });
  } catch (erro) {
    console.error('Erro ping:', erro.response?.data || erro.message);
    res.status(erro.response?.status || 500).json({
      sucesso: false,
      erro: erro.response?.data || erro.message
    });
  }
});

// ============================================================
// CRIAR DEPÓSITO PIX
// ============================================================
app.post('/api/pix/deposit', async (req, res) => {
  try {
    console.log('[DEPÓSITO] Requisição:', req.body);

    const response = await axios.post(
      `${SIGILO_URL}/gateway/pix/deposit`,
      req.body,
      { headers: sigiloHeaders }
    );

    console.log('[DEPÓSITO] Resposta:', response.data);
    res.json(response.data);

  } catch (erro) {
    console.error('[DEPÓSITO] Erro:', erro.response?.data || erro.message);
    res.status(erro.response?.status || 500).json(
      erro.response?.data || { erro: 'Erro no servidor proxy' }
    );
  }
});

// ============================================================
// RECEBER PIX
// ============================================================
app.post('/api/pix/receive', async (req, res) => {
  try {
    const response = await axios.post(
      `${SIGILO_URL}/gateway/pix/receive`,
      req.body,
      { headers: sigiloHeaders }
    );
    res.json(response.data);
  } catch (erro) {
    res.status(erro.response?.status || 500).json(
      erro.response?.data || { erro: 'Erro no servidor proxy' }
    );
  }
});

// ============================================================
// CONSULTAR STATUS (identifier)
// ============================================================
app.get('/api/pix/status/:identifier', async (req, res) => {
  try {
    console.log('[STATUS] Identifier:', req.params.identifier);

    const response = await axios.get(
      `${SIGILO_URL}/gateway/transactions/${req.params.identifier}`,
      { headers: sigiloHeaders }
    );

    res.json(response.data);
  } catch (erro) {
    console.warn('[STATUS] Retornando PENDING');
    res.json({ status: "PENDING", transactionStatus: "PENDING" });
  }
});

// ============================================================
// CONSULTAR POR TRANSACTION ID
// ============================================================
app.get('/api/pix/consulta/:transactionId', async (req, res) => {
  try {
    const response = await axios.get(
      `${SIGILO_URL}/gateway/transactions/${req.params.transactionId}`,
      { headers: sigiloHeaders }
    );
    res.json(response.data);
  } catch (erro) {
    res.status(erro.response?.status || 500).json(
      erro.response?.data || { erro: 'Erro no servidor proxy' }
    );
  }
});

// ============================================================
// CRIAR TRANSFERÊNCIA (SAQUE)
// ============================================================
app.post('/api/pix/transfer', async (req, res) => {
  try {
    console.log('[TRANSFER] Requisição:', req.body);
    const response = await axios.post(
      `${SIGILO_URL}/gateway/transfers`,
      req.body,
      { headers: sigiloHeaders }
    );
    console.log('[TRANSFER] Resposta:', response.data);
    res.json(response.data);
  } catch (erro) {
    console.error('[TRANSFER] Erro:', erro.response?.data || erro.message);
    res.status(erro.response?.status || 500).json(
      erro.response?.data || { erro: 'Erro no servidor proxy' }
    );
  }
});

// ============================================================
// WEBHOOK — SIGILOPAY NOTIFICA PAGAMENTO
// ============================================================
app.post('/api/webhook/sigilopay', async (req, res) => {
  console.log('\n══════════════════════════════════════════════');
  console.log('[WEBHOOK] Notificação recebida da SigiloPay');
  console.log('══════════════════════════════════════════════');
  console.log('Payload:', JSON.stringify(req.body, null, 2));

  try {
    const {
      transactionId,
      status,
      transactionStatus,
      identifier,
      pix,
      amount,
      order
    } = req.body;

    // Verifica se o pagamento foi confirmado
    const pago = transactionStatus === "COMPLETED" ||
                 transactionStatus === "PAID" ||
                 status === "PAID" ||
                 status === "APPROVED" ||
                 status === "OK";

    if (!pago) {
      console.log(`[WEBHOOK] Status não confirmado: ${transactionStatus || status}`);
      return res.json({ recebido: true, processado: false });
    }

    console.log(`[WEBHOOK] ✅ Pagamento confirmado! Identifier: ${identifier}`);

    // Extrai o valor (pode vir em pix.value ou amount)
    const valor = parseFloat(pix?.value || amount || 0);

    if (!valor || valor <= 0) {
      console.error('[WEBHOOK] Valor inválido ou ausente');
      return res.json({ recebido: true, processado: false, erro: 'Valor ausente' });
    }

    // Busca a transação no Firebase pelo identifier
    const searchUrl = `${FIREBASE_URL}/transacoes.json?orderBy="identifier"&equalTo="${identifier}"`;
    const searchResponse = await axios.get(searchUrl);

    const transacoes = searchResponse.data;

    if (!transacoes || Object.keys(transacoes).length === 0) {
      console.error(`[WEBHOOK] Transação não encontrada para identifier: ${identifier}`);
      return res.json({ recebido: true, processado: false, erro: 'Transação não encontrada' });
    }

    const txKey = Object.keys(transacoes)[0];
    const txData = transacoes[txKey];

    // Se já foi aprovada, não faz nada
    if (txData.status === 'aprovada') {
      console.log(`[WEBHOOK] Transação ${txKey} já aprovada. Ignorando.`);
      return res.json({ recebido: true, processado: true, jaAprovada: true });
    }

    const usuarioId = txData.usuario_id;
    const valorDeposito = parseFloat(txData.valor) || valor;

    // Busca o usuário
    const userUrl = `${FIREBASE_URL}/usuarios.json?orderBy="id"&equalTo="${usuarioId}"`;
    const userResponse = await axios.get(userUrl);
    const usuarios = userResponse.data;

    if (!usuarios || Object.keys(usuarios).length === 0) {
      console.error(`[WEBHOOK] Usuário não encontrado: ${usuarioId}`);
      return res.json({ recebido: true, processado: false, erro: 'Usuário não encontrado' });
    }

    const userKey = Object.keys(usuarios)[0];
    const userData = usuarios[userKey];

    // Calcula novos valores
    const novoSaldo = (parseFloat(userData.saldo) || 0) + valorDeposito;

    // Pega lucro atual da plataforma
    const plataformaResponse = await axios.get(`${FIREBASE_URL}/plataforma.json`);
    const plataforma = plataformaResponse.data || {};
    const lucroTotal = (parseFloat(plataforma.lucro_total) || 0) + valorDeposito;
    const lucroDisponivel = (parseFloat(plataforma.lucro_disponivel) || 0) + valorDeposito;

    // Atualiza saldo do usuário
    await axios.patch(`${FIREBASE_URL}/usuarios/${userKey}.json`, {
      saldo: novoSaldo
    });

    // Atualiza lucro da plataforma
    await axios.patch(`${FIREBASE_URL}/plataforma.json`, {
      lucro_total: lucroTotal,
      lucro_disponivel: lucroDisponivel
    });

    // Atualiza transação como aprovada
    await axios.patch(`${FIREBASE_URL}/transacoes/${txKey}.json`, {
      status: 'aprovada',
      aprovado_em: new Date().toISOString(),
      transaction_id: transactionId
    });

    console.log(`[WEBHOOK] ✅ Depósito aprovado!`);
    console.log(`[WEBHOOK] Usuário: ${userData.nome}`);
    console.log(`[WEBHOOK] Valor: R$ ${valorDeposito.toFixed(2)}`);
    console.log(`[WEBHOOK] Novo saldo: R$ ${novoSaldo.toFixed(2)}`);
    console.log('══════════════════════════════════════════════\n');

    res.json({
      recebido: true,
      processado: true,
      usuario: userData.nome,
      valor: valorDeposito,
      novo_saldo: novoSaldo
    });

  } catch (erro) {
    console.error('[WEBHOOK] Erro:', erro.response?.data || erro.message);
    res.status(500).json({ erro: 'Erro ao processar webhook' });
  }
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================
app.listen(PORT, () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  🚀 InvestMax Proxy Server');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  🌐 Rodando em: http://localhost:${PORT}`);
  console.log(`  🔑 SigiloPay: ${SIGILO_PUBLIC?.slice(0, 15)}...`);
  console.log(`  🔥 Firebase: ${FIREBASE_URL}`);
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  console.log('  Endpoints:');
  console.log('  GET  /api/ping');
  console.log('  POST /api/pix/deposit');
  console.log('  POST /api/pix/receive');
  console.log('  GET  /api/pix/status/:identifier');
  console.log('  GET  /api/pix/consulta/:transactionId');
  console.log('  POST /api/pix/transfer');
  console.log('  POST /api/webhook/sigilopay   ← SigiloPay notifica aqui');
  console.log('═══════════════════════════════════════════════════');
  console.log('');
});