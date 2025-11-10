const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Configurações
const GAS_TOKEN_URL = "https://script.google.com/macros/s/AKfycbypQ1Smx0v-2w4brX8FV3D52op3RvKsfzyxoHNq05Fm5AdGDAHaYqvhN7lQ2VY4Ir-H/exec";
const BASE_URL = "https://df-regulacao-api-live.gdf.live.maida.health";
const EVENTOS_GUIA_URL = "https://df-eventos-guia-api-live.gdf.live.maida.health";

// Configurações de retry e timeout
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT = 15000;

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
    
    // Função para enviar mensagens com tratamento de erro
    const sendMessage = (data) => {
        try {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (error) {
            console.log('Cliente desconectado');
        }
    };

    try {
        console.log('Cliente conectado ao SSE para busca de guias OPME');
        
        sendMessage({
            type: 'progress',
            percent: 5,
            message: 'Obtendo token de autenticação...'
        });

        const token = await obterToken();
        if (!token) {
            sendMessage({
                type: 'error',
                message: 'Não foi possível obter o token de autenticação'
            });
            res.end();
            return;
        }

        console.log('Token obtido com sucesso');

        sendMessage({
            type: 'progress',
            percent: 15,
            message: 'Buscando guias OPME em análise...'
        });

        const guiasOPME = await buscarTodasGuiasOPME(token);
        const total = guiasOPME.length;
        
        console.log(`Total de guias encontradas: ${total}`);

        sendMessage({
            type: 'progress',
            percent: 25,
            message: `Encontradas ${total} guias OPME para processar`
        });

        const resultados = {
            autorizadas: [],
            parcialmenteAutorizadas: [],
            negadas: [],
            emAnalise: [],
            semGuiaOrigem: [],
            comErro: []
        };

        if (total === 0) {
            sendMessage({
                type: 'error',
                message: 'Não foi possível buscar as guias OPME. A API pode estar indisponível.'
            });
            res.end();
            return;
        }

        // Processar em lotes menores para evitar timeout do Vercel
        const BATCH_SIZE = 50;
        let processedCount = 0;

        for (let i = 0; i < guiasOPME.length; i++) {
            const guiaOPME = guiasOPME[i];
            const percent = 25 + ((i + 1) / guiasOPME.length * 70);
            
            sendMessage({
                type: 'progress',
                percent: Math.round(percent),
                message: `Processando guia ${i + 1} de ${total}: ${guiaOPME.idGuia}`
            });

            try {
                console.log(`Processando guia OPME: ${guiaOPME.idGuia}`);
                
                // Buscar detalhes da guia OPME com retry
                const detalhesOPME = await fetchWithRetry(
                    () => buscarDetalhesGuiaOPME(guiaOPME.idGuia, token),
                    `detalhes da guia OPME ${guiaOPME.idGuia}`
                );
                
                if (!detalhesOPME) {
                    console.log(`  ❌ Erro ao buscar detalhes da guia OPME`);
                    
                    resultados.comErro.push({
                        guiaOPME: guiaOPME.idGuia,
                        guiaOrigem: "N/A",
                        tipoGuiaOrigem: "Erro ao buscar detalhes",
                        statusOrigem: "N/A",
                        itensOrigem: [],
                        erro: "Falha na requisição de detalhes"
                    });
                    continue;
                }

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

                console.log(`  📋 Guia origem: ${guiaOrigem.autorizacao}`);

                // Buscar status da guia de origem com retry
                const statusOrigem = await fetchWithRetry(
                    () => buscarStatusGuiaOrigem(guiaOrigem.autorizacao, token),
                    `status da guia origem ${guiaOrigem.autorizacao}`
                );
                
                if (!statusOrigem) {
                    console.log(`  ⚠️  Status da guia de origem não encontrado`);
                    continue;
                }

                console.log(`  📊 Status origem: ${statusOrigem}`);

                // Buscar detalhes completos da guia de origem com retry
                const detalhesOrigem = await fetchWithRetry(
                    () => buscarDetalhesGuiaOrigem(guiaOrigem.id, token),
                    `detalhes da guia origem ${guiaOrigem.id}`
                );
                
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

                classificarResultado(resultados, resultado);

            } catch (error) {
                console.error(`Erro ao processar guia OPME ${guiaOPME.idGuia}:`, error.message);
                
                resultados.comErro.push({
                    guiaOPME: guiaOPME.idGuia,
                    guiaOrigem: "N/A",
                    tipoGuiaOrigem: "Erro no processamento",
                    statusOrigem: "N/A",
                    itensOrigem: [],
                    erro: error.message
                });
            }

            processedCount++;
            
            // A cada lote, enviar resultados parciais para evitar timeout
            if (processedCount % BATCH_SIZE === 0) {
                console.log(`Processados ${processedCount} guias de ${total}`);
                sendMessage({
                    type: 'progress',
                    percent: Math.round(25 + (processedCount / guiasOPME.length * 70)),
                    message: `Processados ${processedCount} de ${total} guias...`
                });
            }

            await new Promise(resolve => setTimeout(resolve, 100));
        }

        sendMessage({
            type: 'progress',
            percent: 98,
            message: 'Finalizando processamento...'
        });

        await new Promise(resolve => setTimeout(resolve, 500));

        sendMessage({
            type: 'complete',
            resultados: resultados
        });

        console.log('Processamento concluído com sucesso!');
        console.log('Resumo:', {
            autorizadas: resultados.autorizadas.length,
            parcialmenteAutorizadas: resultados.parcialmenteAutorizadas.length,
            negadas: resultados.negadas.length,
            emAnalise: resultados.emAnalise.length,
            semGuiaOrigem: resultados.semGuiaOrigem.length,
            comErro: resultados.comErro.length
        });
        res.end();
        
    } catch (error) {
        console.error('Erro no processamento SSE:', error);
        sendMessage({
            type: 'error',
            message: error.message
        });
        res.end();
    }
});

// ===== FUNÇÕES AUXILIARES ROBUSTAS =====

// Função com retry logic
async function fetchWithRetry(fetchFunction, description, retries = MAX_RETRIES) {
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
            const result = await fetchFunction();
            return result;
        } catch (error) {
            console.log(`Tentativa ${attempt}/${retries + 1} falhou para ${description}:`, error.message);
            
            if (attempt <= retries) {
                const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
                console.log(`Aguardando ${delay}ms antes da próxima tentativa...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.log(`Todas as tentativas falharam para ${description}`);
                return null;
            }
        }
    }
}

// Função para obter token
async function obterToken() {
    return await fetchWithRetry(async () => {
        console.log('Buscando token...');
        const response = await fetch(GAS_TOKEN_URL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        console.log('Token obtido com sucesso');
        return data.token;
    }, 'obter token');
}

// Buscar todas as guias OPME em análise
async function buscarTodasGuiasOPME(token) {
    return await fetchWithRetry(async () => {
        let todasGuias = [];
        let page = 0;
        const size = 100;
        let hasMore = true;

        console.log('Iniciando busca de todas as guias OPME...');
        
        while (hasMore && page < 10) { // Safety limit
            const url = `${BASE_URL}/v2/cotacao-opme/em-analise?page=${page}&size=${size}`;
            
            console.log(`Buscando página ${page}...`);
            
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
            
            console.log(`Página ${page}:`, {
                contentLength: data.content?.length,
                totalElements: data.totalElements,
                totalPages: data.totalPages,
                last: data.last
            });

            if (!data.content || data.content.length === 0) {
                console.log('Página vazia - fim da paginação');
                break;
            }

            todasGuias = todasGuias.concat(data.content);
            console.log(`Página ${page}: ${data.content.length} guias encontradas`);

            if (data.last === true || data.content.length < size) {
                hasMore = false;
            } else {
                page++;
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        console.log(`Busca concluída: ${todasGuias.length} guias encontradas`);
        return todasGuias;
    }, 'buscar todas as guias OPME');
}

// Buscar detalhes da guia OPME com tratamento de JSON
async function buscarDetalhesGuiaOPME(idGuia, token) {
    try {
        const url = `${BASE_URL}/v2/buscar-guia/detalhamento-guia/${idGuia}/OPME`;
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            console.log(`Erro ${response.status} ao buscar detalhes da guia OPME ${idGuia}`);
            return null;
        }

        // Ler a resposta como texto primeiro para evitar erros de JSON
        const text = await response.text();
        if (!text) {
            console.log(`Resposta vazia para guia OPME ${idGuia}`);
            return null;
        }

        try {
            return JSON.parse(text);
        } catch (parseError) {
            console.error(`Erro ao fazer parse JSON da guia OPME ${idGuia}:`, parseError.message);
            console.log(`Conteúdo da resposta: ${text.substring(0, 200)}...`);
            return null;
        }
    } catch (error) {
        console.error(`Erro ao buscar detalhes da guia OPME ${idGuia}:`, error.message);
        throw error;
    }
}

// Buscar status da guia de origem
async function buscarStatusGuiaOrigem(numeroGuia, token) {
    try {
        const url = `${EVENTOS_GUIA_URL}/historico/prestador?page=0&size=10&numeroGuia=${numeroGuia}`;
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            console.log(`Erro ${response.status} ao buscar status da guia ${numeroGuia}`);
            return null;
        }

        const text = await response.text();
        if (!text) {
            console.log(`Resposta vazia para status da guia ${numeroGuia}`);
            return null;
        }

        try {
            const data = JSON.parse(text);
            
            if (data.content && data.content.length > 0) {
                return data.content[0].situacaoAtual || "Status não disponível";
            }
            
            return "Status não encontrado";
        } catch (parseError) {
            console.error(`Erro ao fazer parse JSON do status da guia ${numeroGuia}:`, parseError.message);
            return null;
        }
    } catch (error) {
        console.error(`Erro ao buscar status da guia ${numeroGuia}:`, error.message);
        throw error;
    }
}

// Buscar detalhes completos da guia de origem
async function buscarDetalhesGuiaOrigem(idGuia, token) {
    try {
        const url = `${BASE_URL}/v2/buscar-guia/detalhamento-guia/${idGuia}/SOLICITACAO_INTERNACAO`;
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            console.log(`Erro ${response.status} ao buscar detalhes da guia de origem ${idGuia}`);
            return null;
        }

        const text = await response.text();
        if (!text) {
            console.log(`Resposta vazia para guia de origem ${idGuia}`);
            return null;
        }

        try {
            return JSON.parse(text);
        } catch (parseError) {
            console.error(`Erro ao fazer parse JSON da guia de origem ${idGuia}:`, parseError.message);
            return null;
        }
    } catch (error) {
        console.error(`Erro ao buscar detalhes da guia de origem ${idGuia}:`, error.message);
        throw error;
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
