const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Configurações
const GAS_TOKEN_URL = "https://script.google.com/macros/s/AKfycbypQ1Smx0v-2w4brX8FV3D52op3RvKsfzyxoHNq05Fm5AdGDAHaYqvhN7lQ2VY4Ir-H/exec";
const BASE_URL = "https://df-regulacao-api-live.gdf.live.maida.health";
const EVENTOS_GUIA_URL = "https://df-eventos-guia-api-live.gdf.live.maida.health";

// Timeouts para evitar problemas
const REQUEST_TIMEOUT = 15000; // 15 segundos para API mais lenta

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Rota para servir a página HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Rota da API para buscar guias com progresso
app.get('/api/guias-opme-progress', async (req, res) => {
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
            emAnalise: [],
            semGuiaOrigem: []
        };

        for (let i = 0; i < guiasOPME.length; i++) {
            const guiaOPME = guiasOPME[i];
            const percent = 25 + ((i + 1) / guiasOPME.length * 70);
            
            res.write(`data: ${JSON.stringify({
                type: 'progress',
                percent: Math.round(percent),
                message: `Processando guia ${i + 1} de ${total}: ${guiaOPME.idGuia}`
            })}\n\n`);

            try {
                console.log(`Processando guia OPME: ${guiaOPME.idGuia}`);
                
                // Buscar detalhes da guia OPME
                const detalhesOPME = await buscarDetalhesGuiaOPME(guiaOPME.idGuia, token);
                
                if (!detalhesOPME?.guia?.guiaOrigem) {
                    console.log(`  ⚠️  Sem guia de origem`);
                    
                    resultados.semGuiaOrigem.push({
                        guiaOPME: detalhesOPME?.guia?.autorizacao || guiaOPME.idGuia,
                        guiaOrigem: "N/A",
                        tipoGuiaOrigem: "Sem guia de origem",
                        statusOrigem: "N/A",
                        itensOrigem: []
                    });
                    continue;
                }

                const guiaOrigem = detalhesOPME.guia.guiaOrigem;
                
                if (!guiaOrigem.autorizacao) {
                    console.log(`  ⚠️  Guia de origem sem número de autorização`);
                    
                    resultados.semGuiaOrigem.push({
                        guiaOPME: detalhesOPME.guia.autorizacao || guiaOPME.idGuia,
                        guiaOrigem: "N/A",
                        tipoGuiaOrigem: "Sem número de autorização",
                        statusOrigem: "N/A",
                        itensOrigem: []
                    });
                    continue;
                }

                // Buscar status da guia de origem
                const statusOrigem = await buscarStatusGuiaOrigem(guiaOrigem.autorizacao, token);
                
                if (!statusOrigem) {
                    console.log(`  ⚠️  Status da guia de origem não encontrado`);
                    continue;
                }

                // Buscar detalhes completos da guia de origem
                const detalhesOrigem = await buscarDetalhesGuiaOrigem(guiaOrigem.id, token);
                
                const resultado = {
                    guiaOPME: detalhesOPME.guia.autorizacao || guiaOPME.idGuia,
                    guiaOrigem: guiaOrigem.autorizacao,
                    tipoGuiaOrigem: "Guia de Internação",
                    statusOrigem: statusOrigem,
                    itensOrigem: detalhesOrigem?.procedimentosSolicitado?.map(item => ({
                        codigo: item.procedimento?.codigoProcedimento,
                        descricao: item.procedimento?.descricaoProcedimento,
                        quantSolicitada: item.quantidadeSolicitada,
                        quantAutorizada: item.quantidadeAutorizada
                    })) || []
                };

                // Classificar por status
                classificarResultado(resultados, resultado);

            } catch (error) {
                console.error(`Erro ao processar guia OPME ${guiaOPME.idGuia}:`, error.message);
            }

            // Delay maior para API do GDF
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        res.write(`data: ${JSON.stringify({
            type: 'progress',
            percent: 98,
            message: 'Finalizando processamento...'
        })}\n\n`);

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

// ===== FUNÇÕES AUXILIARES PARA API DO GDF =====

// Função para obter token com timeout
async function obterToken() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        
        const response = await fetch(GAS_TOKEN_URL, {
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        return await response.json().then(data => data.token);
    } catch (error) {
        console.error("Erro ao obter token:", error);
        return null;
    }
}

// Buscar todas as guias OPME em análise (API do GDF)
async function buscarTodasGuiasOPME(token) {
    let todasGuias = [];
    let page = 0;
    let hasMore = true;

    while (hasMore) {
        const url = `${BASE_URL}/v2/cotacao-opme/em-analise?page=${page}&size=50`;
        
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
            
            console.log(`Buscando página ${page}...`);
            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                console.log(`Erro HTTP ${response.status} na página ${page}`);
                break;
            }

            const data = await response.json();
            
            console.log(`Página ${page}:`, {
                contentLength: data.content?.length,
                totalElements: data.totalElements,
                totalPages: data.totalPages,
                last: data.last
            });

            if (data.content && data.content.length > 0) {
                todasGuias = todasGuias.concat(data.content);
                console.log(`Página ${page}: ${data.content.length} guias encontradas`);
                
                // Verificar se há mais páginas
                if (data.last === true || page >= (data.totalPages || 10) - 1) {
                    hasMore = false;
                } else {
                    page++;
                }
            } else {
                hasMore = false;
            }

            // Delay entre páginas
            await new Promise(resolve => setTimeout(resolve, 500));

        } catch (error) {
            if (error.name === 'AbortError') {
                console.error(`Timeout ao buscar página ${page}`);
            } else {
                console.error(`Erro ao buscar página ${page}:`, error);
            }
            hasMore = false;
        }
    }

    console.log(`Total de guias encontradas: ${todasGuias.length}`);
    return todasGuias;
}

// Buscar detalhes da guia OPME
async function buscarDetalhesGuiaOPME(idGuia, token) {
    const url = `${BASE_URL}/v2/buscar-guia/detalhamento-guia/${idGuia}/OPME`;
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.log(`Erro ${response.status} ao buscar detalhes da guia OPME ${idGuia}`);
            return null;
        }
        return await response.json();
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error(`Timeout ao buscar detalhes da guia OPME ${idGuia}`);
        } else {
            console.error(`Erro ao buscar detalhes da guia OPME ${idGuia}:`, error.message);
        }
        return null;
    }
}

// Buscar status da guia de origem
async function buscarStatusGuiaOrigem(numeroGuia, token) {
    const url = `${EVENTOS_GUIA_URL}/historico/prestador?page=0&size=10&numeroGuia=${numeroGuia}`;
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.log(`Erro ${response.status} ao buscar status da guia ${numeroGuia}`);
            return null;
        }

        const data = await response.json();
        
        if (data.content && data.content.length > 0) {
            return data.content[0].situacaoAtual || "Status não disponível";
        }
        
        return "Status não encontrado";
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error(`Timeout ao buscar status da guia ${numeroGuia}`);
        } else {
            console.error(`Erro ao buscar status da guia ${numeroGuia}:`, error.message);
        }
        return null;
    }
}

// Buscar detalhes completos da guia de origem
async function buscarDetalhesGuiaOrigem(idGuia, token) {
    const url = `${BASE_URL}/v2/buscar-guia/detalhamento-guia/${idGuia}/SOLICITACAO_INTERNACAO`;
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.log(`Erro ${response.status} ao buscar detalhes da guia de origem ${idGuia}`);
            return null;
        }
        return await response.json();
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error(`Timeout ao buscar detalhes da guia de origem ${idGuia}`);
        } else {
            console.error(`Erro ao buscar detalhes da guia de origem ${idGuia}:`, error.message);
        }
        return null;
    }
}

// Função para classificar o resultado
function classificarResultado(resultados, resultado) {
    const status = resultado.statusOrigem?.toUpperCase() || '';
    
    if (status.includes('AUTORIZADA') && !status.includes('PARCIALMENTE')) {
        resultados.autorizadas.push(resultado);
        console.log(`  ✅ Autorizada - Guia Origem: ${resultado.guiaOrigem}`);
    } else if (status.includes('PARCIALMENTE')) {
        resultados.parcialmenteAutorizadas.push(resultado);
        console.log(`  ⚠️  Parcialmente Autorizada - Guia Origem: ${resultado.guiaOrigem}`);
    } else if (status.includes('NEGADA')) {
        resultados.negadas.push(resultado);
        console.log(`  ❌ Negada - Guia Origem: ${resultado.guiaOrigem}`);
    } else {
        resultados.emAnalise.push(resultado);
        console.log(`  ⏳ Em Análise - Guia Origem: ${resultado.guiaOrigem}`);
    }
}

app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
