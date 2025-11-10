const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Configurações
const GAS_TOKEN_URL = "https://script.google.com/macros/s/AKfycbypQ1Smx0v-2w4brX8FV3D52op3RvKsfzyxoHNq05Fm5AdGDAHaYqvhN7lQ2VY4Ir-H/exec";
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

        console.log('Token obtido com sucesso');

        res.write(`data: ${JSON.stringify({
            type: 'progress',
            percent: 15,
            message: 'Buscando guias OPME em análise...'
        })}\n\n`);

        const guiasOPME = await buscarTodasGuiasOPME(token);
        const total = guiasOPME.length;
        
        console.log(`Total de guias encontradas: ${total}`);

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

        // Se não encontrou guias, tentar método alternativo
        if (total === 0) {
            res.write(`data: ${JSON.stringify({
                type: 'error',
                message: 'Não foi possível buscar as guias OPME. A API pode estar indisponível.'
            })}\n\n`);
            res.end();
            return;
        }

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
                
                if (!detalhesOPME) {
                    console.log(`  ❌ Erro ao buscar detalhes da guia OPME`);
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

                // Buscar status da guia de origem
                const statusOrigem = await buscarStatusGuiaOrigem(guiaOrigem.autorizacao, token);
                
                if (!statusOrigem) {
                    console.log(`  ⚠️  Status da guia de origem não encontrado`);
                    continue;
                }

                console.log(`  📊 Status origem: ${statusOrigem}`);

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

            // Delay para não sobrecarregar
            await new Promise(resolve => setTimeout(resolve, 200));
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
        console.log('Resumo:', {
            autorizadas: resultados.autorizadas.length,
            parcialmenteAutorizadas: resultados.parcialmenteAutorizadas.length,
            negadas: resultados.negadas.length,
            emAnalise: resultados.emAnalise.length,
            semGuiaOrigem: resultados.semGuiaOrigem.length
        });
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

// ===== FUNÇÕES AUXILIARES SIMPLIFICADAS =====

// Função para obter token
async function obterToken() {
    try {
        console.log('Buscando token...');
        const response = await fetch(GAS_TOKEN_URL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        console.log('Token obtido com sucesso');
        return data.token;
    } catch (error) {
        console.error("Erro ao obter token:", error);
        return null;
    }
}

// Buscar todas as guias OPME em análise - Versão simplificada
async function buscarTodasGuiasOPME(token) {
    let todasGuias = [];
    let page = 0;
    const size = 50; // Aumentar para buscar mais itens por página
    let totalPages = null;

    try {
        console.log('Iniciando busca de todas as guias OPME...');
        
        while (true) {
            const url = `${BASE_URL}/v2/cotacao-opme/em-analise?page=${page}&size=${size}`;
            
            console.log(`Buscando página ${page}...`);
            
            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                signal: AbortSignal.timeout(30000)
            });

            console.log('Status da resposta:', response.status);
            
            if (!response.ok) {
                console.log('Response not OK:', response.status, response.statusText);
                break;
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

            // Atualizar totalPages da primeira resposta
            if (totalPages === null && data.totalPages !== undefined) {
                totalPages = data.totalPages;
                console.log(`Total de páginas a serem buscadas: ${totalPages}`);
            }

            // Verificar se é a última página
            if (data.last === true) {
                console.log('Última página alcançada');
                break;
            }

            // Verificar baseado no totalPages
            if (totalPages !== null && page >= totalPages - 1) {
                console.log(`Todas as ${totalPages} páginas foram buscadas`);
                break;
            }

            page++;

            // Pequeno delay entre páginas para não sobrecarregar
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log(`Busca concluída: ${todasGuias.length} guias encontradas em ${page + 1} páginas`);
        return todasGuias;
        
    } catch (error) {
        console.error('Erro ao buscar guias OPME:', error.message);
        if (error.name === 'TimeoutError') {
            console.error('Timeout na requisição das guias OPME');
        }
        return todasGuias; // Retorna o que conseguiu buscar até o momento
    }
}
// Buscar detalhes da guia OPME - Versão simplificada
async function buscarDetalhesGuiaOPME(idGuia, token) {
    try {
        const url = `${BASE_URL}/v2/buscar-guia/detalhamento-guia/${idGuia}/OPME`;
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
            console.log(`Erro ${response.status} ao buscar detalhes da guia OPME ${idGuia}`);
            return null;
        }
        return await response.json();
    } catch (error) {
        if (error.name === 'TimeoutError') {
            console.error(`Timeout ao buscar detalhes da guia OPME ${idGuia}`);
        } else {
            console.error(`Erro ao buscar detalhes da guia OPME ${idGuia}:`, error.message);
        }
        return null;
    }
}

// Buscar status da guia de origem - Versão simplificada
async function buscarStatusGuiaOrigem(numeroGuia, token) {
    try {
        const url = `${EVENTOS_GUIA_URL}/historico/prestador?page=0&size=10&numeroGuia=${numeroGuia}`;
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(15000)
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
        if (error.name === 'TimeoutError') {
            console.error(`Timeout ao buscar status da guia ${numeroGuia}`);
        } else {
            console.error(`Erro ao buscar status da guia ${numeroGuia}:`, error.message);
        }
        return null;
    }
}

// Buscar detalhes completos da guia de origem - Versão simplificada
async function buscarDetalhesGuiaOrigem(idGuia, token) {
    try {
        const url = `${BASE_URL}/v2/buscar-guia/detalhamento-guia/${idGuia}/SOLICITACAO_INTERNACAO`;
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
            console.log(`Erro ${response.status} ao buscar detalhes da guia de origem ${idGuia}`);
            return null;
        }
        return await response.json();
    } catch (error) {
        if (error.name === 'TimeoutError') {
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
