const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurações
const GAS_TOKEN_URL = process.env.GAS_TOKEN_URL;
const BASE_URL = "https://df-regulacao-api-live.gdf.live.maida.health";
const EVENTOS_GUIA_URL = "https://df-eventos-guia-api-live.gdf.live.maida.health";

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
            semGuiaOrigem: [] // Nova categoria para OPME sem guia de origem
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
                    console.log(`  ⚠️  Sem guia de origem - adicionando à lista de sem guia origem`);
                    
                    const resultadoSemOrigem = {
                        guiaOPME: detalhesOPME?.guia?.autorizacao || guiaOPME.idGuia,
                        guiaOrigem: "N/A",
                        tipoGuiaOrigem: "Sem guia de origem",
                        statusOrigem: "N/A",
                        itensOrigem: []
                    };
                    
                    resultados.semGuiaOrigem.push(resultadoSemOrigem);
                    continue;
                }

                const guiaOrigem = detalhesOPME.guia.guiaOrigem;
                
                if (!guiaOrigem.autorizacao) {
                    console.log(`  ⚠️  Guia de origem sem número de autorização`);
                    
                    const resultadoSemOrigem = {
                        guiaOPME: detalhesOPME.guia.autorizacao || guiaOPME.idGuia,
                        guiaOrigem: "N/A",
                        tipoGuiaOrigem: "Sem número de autorização",
                        statusOrigem: "N/A",
                        itensOrigem: []
                    };
                    
                    resultados.semGuiaOrigem.push(resultadoSemOrigem);
                    continue;
                }

                // Buscar status da guia de origem na API de eventos
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
        console.log(`Resumo: ${resultados.autorizadas.length} autorizadas, ${resultados.parcialmenteAutorizadas.length} parcialmente autorizadas, ${resultados.negadas.length} negadas, ${resultados.emAnalise.length} em análise, ${resultados.semGuiaOrigem.length} sem guia de origem`);
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

// ===== FUNÇÕES AUXILIARES ATUALIZADAS =====

// Função para obter token
async function obterToken() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        
        const response = await fetch(GAS_TOKEN_URL, {
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const text = await response.text();
        if (!text) {
            throw new Error('Resposta vazia do servidor de token');
        }
        
        try {
            const data = JSON.parse(text);
            return data.token;
        } catch (parseError) {
            console.error("Erro ao fazer parse do token:", parseError);
            return null;
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error("Timeout ao obter token");
        } else {
            console.error("Erro ao obter token:", error);
        }
        return null;
    }
}

// Buscar todas as guias OPME em análise (nova API)
async function buscarTodasGuiasOPME(token) {
    let todasGuias = [];
    let page = 0;
    const size = 100; // Aumentar ainda mais para buscar todas de uma vez

    while (true) {
        const url = `${BASE_URL}/v2/cotacao-opme/em-analise?page=${page}&size=${size}`;
        
        try {
            console.log(`Buscando página ${page}...`);
            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                console.log(`Erro HTTP ${response.status} na página ${page}`);
                break;
            }

            const data = await response.json();
            
            console.log(`Resposta da página ${page}:`, {
                contentLength: data.content?.length,
                totalElements: data.totalElements,
                totalPages: data.totalPages,
                last: data.last,
                first: data.first,
                number: data.number,
                size: data.size
            });

            if (!data.content || data.content.length === 0) {
                console.log(`Página ${page} vazia - fim da paginação`);
                break;
            }

            todasGuias = todasGuias.concat(data.content);
            console.log(`Página ${page}: ${data.content.length} guias encontradas`);

            // Verificar se é a última página
            if (data.last === true || page >= (data.totalPages || 10) - 1) {
                console.log(`Última página alcançada: ${page}`);
                break;
            }

            page++;

        } catch (error) {
            console.error(`Erro ao buscar página ${page}:`, error);
            break;
        }
    }

    console.log(`Busca concluída: ${todasGuias.length} guias encontradas em ${page + 1} páginas`);
    return todasGuias;
}

// Buscar detalhes da guia OPME
async function buscarDetalhesGuiaOPME(idGuia, token) {
    const url = `${BASE_URL}/v2/buscar-guia/detalhamento-guia/${idGuia}/OPME`;
    
    try {
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
        return await response.json();
    } catch (error) {
        console.error(`Erro ao buscar detalhes da guia OPME ${idGuia}:`, error.message);
        return null;
    }
}

// Buscar status da guia de origem
async function buscarStatusGuiaOrigem(numeroGuia, token) {
    const url = `${EVENTOS_GUIA_URL}/historico/prestador?page=0&size=10&tipoGuia=&statusSolicitacao=&statusRegulacao=&statusFaturamento=&numeroGuiaPrestador=&senha=&numeroGuia=${numeroGuia}&cpfBeneficiario=&codigoOuDescricao=&tipoProcesso=`;
    
    try {
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

        const data = await response.json();
        
        if (data.content && data.content.length > 0) {
            return data.content[0].situacaoAtual || "Status não disponível";
        }
        
        return "Status não encontrado";
    } catch (error) {
        console.error(`Erro ao buscar status da guia ${numeroGuia}:`, error.message);
        return null;
    }
}

// Buscar detalhes completos da guia de origem
async function buscarDetalhesGuiaOrigem(idGuia, token) {
    const url = `${BASE_URL}/v2/buscar-guia/detalhamento-guia/${idGuia}/SOLICITACAO_INTERNACAO`;
    
    try {
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
        return await response.json();
    } catch (error) {
        console.error(`Erro ao buscar detalhes da guia de origem ${idGuia}:`, error.message);
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
            emAnalise: [],
            semGuiaOrigem: []
        };

        for (const guiaOPME of guiasOPME) {
            console.log(`Processando guia OPME: ${guiaOPME.idGuia}`);
            
            const detalhesOPME = await buscarDetalhesGuiaOPME(guiaOPME.idGuia, token);
            
            if (!detalhesOPME?.guia?.guiaOrigem) {
                console.log(`  ⚠️  Sem guia de origem`);
                
                const resultadoSemOrigem = {
                    guiaOPME: detalhesOPME?.guia?.autorizacao || guiaOPME.idGuia,
                    guiaOrigem: "N/A",
                    tipoGuiaOrigem: "Sem guia de origem",
                    statusOrigem: "N/A",
                    itensOrigem: []
                };
                
                resultados.semGuiaOrigem.push(resultadoSemOrigem);
                continue;
            }

            const guiaOrigem = detalhesOPME.guia.guiaOrigem;
            
            if (!guiaOrigem.autorizacao) {
                console.log(`  ⚠️  Guia de origem sem número de autorização`);
                
                const resultadoSemOrigem = {
                    guiaOPME: detalhesOPME.guia.autorizacao || guiaOPME.idGuia,
                    guiaOrigem: "N/A",
                    tipoGuiaOrigem: "Sem número de autorização",
                    statusOrigem: "N/A",
                    itensOrigem: []
                };
                
                resultados.semGuiaOrigem.push(resultadoSemOrigem);
                continue;
            }

            const statusOrigem = await buscarStatusGuiaOrigem(guiaOrigem.autorizacao, token);
            
            if (!statusOrigem) {
                console.log(`  ⚠️  Status da guia de origem não encontrado`);
                continue;
            }

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

app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
