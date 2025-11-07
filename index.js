const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurações
const GAS_TOKEN_URL = process.env.GAS_TOKEN_URL;
const BASE_URL = process.env.BASE_URL || "https://df-regulacao-api-live.gdf.live.maida.health";

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/img', express.static(path.join(__dirname, 'public', 'img')));

// Rota para servir a página HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Rota da API para buscar guias com progresso
app.get('/api/guias-opme-progress', async (req, res) => {
    console.log('📢 ROTA /api/guias-opme-progress ACESSADA');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    try {
        console.log('Cliente conectado ao SSE para busca de guias OPME');
        
        // Enviar progresso inicial
        res.write(`data: ${JSON.stringify({
            type: 'progress',
            percent: 5,
            message: 'Obtendo token de autenticação...'
        })}\n\n`);

        const token = await obterToken();
        if (!token) {
            res.write(`data: ${JSON.stringify({
                type: 'error',
                message: 'Não foi possível obter o token de autenticação'
            })}\n\n`);
            res.end();
            return;
        }

        res.write(`data: ${JSON.stringify({
            type: 'progress',
            percent: 15,
            message: 'Buscando guias OPME em análise...'
        })}\n\n`);

        const guiasOPME = await buscarTodasGuiasOPME(token);
        const total = guiasOPME.length;
        
        res.write(`data: ${JSON.stringify({
            type: 'progress',
            percent: 25,
            message: `Encontradas ${total} guias OPME para processar`
        })}\n\n`);

        const resultados = {
            autorizadas: [],
            parcialmenteAutorizadas: [],
            negadas: [],
            emAnalise: []
        };

        for (let i = 0; i < guiasOPME.length; i++) {
            const guiaOPME = guiasOPME[i];
            const percent = 25 + ((i + 1) / guiasOPME.length * 70);
            
            res.write(`data: ${JSON.stringify({
                type: 'progress',
                percent: Math.round(percent),
                message: `Processando guia ${i + 1} de ${total}: ${guiaOPME.autorizacaoGuia}`
            })}\n\n`);

            try {
                console.log(`Processando guia OPME: ${guiaOPME.autorizacaoGuia}`);
                
                const detalhesOPME = await buscarDetalhesGuia(guiaOPME.idGuia, token);
                
                if (!detalhesOPME?.guia?.guiaOrigem) {
                    console.log(`  ⚠️  Sem guia de origem`);
                    continue;
                }

                const guiaOrigem = detalhesOPME.guia.guiaOrigem;
                
                if (!guiaOrigem.id) {
                    console.log(`  ⚠️  Guia de origem sem ID`);
                    continue;
                }

                const detalhesOrigem = await buscarDetalhesGuia(guiaOrigem.id, token);
                
                if (!detalhesOrigem) continue;

                const resultado = {
                    guiaOPME: guiaOPME.autorizacaoGuia,
                    guiaOrigem: guiaOrigem.autorizacao,
                    tipoGuiaOrigem: "Guia de Internação",
                    statusOrigem: detalhesOrigem.guia?.situacao || "Status não disponível",
                    itensOrigem: detalhesOrigem.guia?.itensGuia || []
                };

                // Classificar por status
                classificarResultado(resultados, resultado);

            } catch (error) {
                console.error(`Erro ao processar guia OPME ${guiaOPME.autorizacaoGuia}:`, error.message);
            }

            // Pequeno delay para não sobrecarregar a API
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        res.write(`data: ${JSON.stringify({
            type: 'progress',
            percent: 98,
            message: 'Finalizando processamento...'
        })}\n\n`);

        // Aguardar um pouco para mostrar o 100%
        await new Promise(resolve => setTimeout(resolve, 500));

        res.write(`data: ${JSON.stringify({
            type: 'complete',
            resultados: resultados
        })}\n\n`);

        console.log('Processamento concluído com sucesso!');
        res.end();
        
    } catch (error) {
        console.error('Erro no processamento SSE:', error);
        res.write(`data: ${JSON.stringify({
            type: 'error',
            message: error.message
        })}\n\n`);
        res.end();
    }
});

// Rota da API original (mantida para compatibilidade)
app.get('/api/guias-opme', async (req, res) => {
    try {
        console.log('Recebida requisição para buscar guias OPME...');
        const resultados = await buscarGuiasOPME();
        res.json(resultados);
    } catch (error) {
        console.error('Erro na rota /api/guias-opme:', error);
        res.status(500).json({ 
            error: 'Erro ao buscar guias OPME', 
            message: error.message 
        });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ===== FUNÇÕES AUXILIARES =====

// Função para obter token
async function obterToken() {
    try {
        const response = await fetch(GAS_TOKEN_URL);
        const data = await response.json();
        return data.token;
    } catch (error) {
        console.error("Erro ao obter token:", error);
        return null;
    }
}

// Função para buscar todas as guias OPME (com paginação)
async function buscarTodasGuiasOPME(token) {
    let todasGuias = [];
    let page = 0;
    let hasMore = true;

    while (hasMore) {
        const url = `${BASE_URL}/v3/historico-cliente?ordenarPor=DATA_SOLICITACAO&tipoDeGuia=SOLICITACAO_DE_OPME&page=${page}&listaDeStatus=EM_ANALISE`;
        
        try {
            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            
            if (data.content && data.content.length > 0) {
                todasGuias = todasGuias.concat(data.content);
                console.log(`Página ${page}: ${data.content.length} guias encontradas`);
                
                // Verificar se há mais páginas
                if (data.last === true || data.content.length < data.size) {
                    hasMore = false;
                } else {
                    page++;
                }
            } else {
                hasMore = false;
            }

        } catch (error) {
            console.error(`Erro ao buscar página ${page}:`, error);
            hasMore = false;
        }
    }

    return todasGuias;
}

// Função para buscar detalhes de uma guia específica
async function buscarDetalhesGuia(idGuia, token) {
    const url = `${BASE_URL}/v2/buscar-guia/detalhamento-guia/${idGuia}`;
    
    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        console.error(`Erro ao buscar detalhes da guia ${idGuia}:`, error.message);
        return null;
    }
}

// Função para classificar o resultado
function classificarResultado(resultados, resultado) {
    const status = resultado.statusOrigem?.toUpperCase() || '';
    
    if (status.includes('AUTORIZADA') && !status.includes('PARCIALMENTE')) {
        resultados.autorizadas.push(resultado);
        console.log(`  ✅ Autorizada`);
    } else if (status.includes('PARCIALMENTE')) {
        resultados.parcialmenteAutorizadas.push(resultado);
        console.log(`  ⚠️  Parcialmente Autorizada`);
    } else if (status.includes('NEGADA')) {
        resultados.negadas.push(resultado);
        console.log(`  ❌ Negada`);
    } else {
        resultados.emAnalise.push(resultado);
        console.log(`  ⏳ Em Análise`);
    }
}

// Função principal (para a rota original)
async function buscarGuiasOPME() {
    try {
        console.log("Iniciando busca de guias OPME em análise...");
        
        const token = await obterToken();
        if (!token) throw new Error("Não foi possível obter o token");

        const guiasOPME = await buscarTodasGuiasOPME(token);
        console.log(`Encontradas ${guiasOPME.length} guias OPME em análise`);

        const resultados = {
            autorizadas: [],
            parcialmenteAutorizadas: [],
            negadas: [],
            emAnalise: []
        };

        for (const guiaOPME of guiasOPME) {
            console.log(`Processando guia OPME: ${guiaOPME.autorizacaoGuia}`);
            
            const detalhesOPME = await buscarDetalhesGuia(guiaOPME.idGuia, token);
            
            if (!detalhesOPME?.guia?.guiaOrigem) {
                console.log(`  ⚠️  Sem guia de origem`);
                continue;
            }

            const guiaOrigem = detalhesOPME.guia.guiaOrigem;
            
            if (!guiaOrigem.id) {
                console.log(`  ⚠️  Guia de origem sem ID`);
                continue;
            }

            const detalhesOrigem = await buscarDetalhesGuia(guiaOrigem.id, token);
            
            if (!detalhesOrigem) continue;

            const resultado = {
                guiaOPME: guiaOPME.autorizacaoGuia,
                guiaOrigem: guiaOrigem.autorizacao,
                tipoGuiaOrigem: "Guia de Internação",
                statusOrigem: detalhesOrigem.guia?.situacao || "Status não disponível",
                itensOrigem: detalhesOrigem.guia?.itensGuia || []
            };

            classificarResultado(resultados, resultado);
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        console.log("Busca concluída com sucesso!");
        return resultados;

    } catch (error) {
        console.error("Erro na execução:", error.message);
        throw error;
    }
}
app.get('/api/teste', (req, res) => {
    console.log('✅ Rota /api/teste funcionando');
    res.json({ message: 'API funcionando!', timestamp: new Date().toISOString() });
});
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
