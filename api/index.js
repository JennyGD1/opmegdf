// server.js
const express = require('express');
const path = require('path');
const cors = require('cors');
const fetch = require('node-fetch'); // Usando node-fetch para compatibilidade com Node.js

const app = express();
const PORT = 3000;

// Configurações de API
const API_BASE_URL = 'https://df-regulacao-api-live.gdf.live.maida.health/v2/buscar-guia/detalhamento-guia/';
const API_LISTA_BASE = 'https://df-regulacao-api-live.gdf.live.maida.health/v2/cotacao-opme/em-analise';

// Seu GAS Token URL
const GAS_TOKEN_URL = process.env.GAS_TOKEN_URL;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Servir arquivos estáticos da pasta 'public'

// Rota para servir a página HTML (ajustada para servir o index.html na pasta public)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Funções de Utilitário e API

/**
 * Obtém o token do Google Apps Script.
 * @returns {Promise<string|null>} O token de acesso ou null.
 */
async function obterToken() {
    try {
        const response = await fetch(GAS_TOKEN_URL);
        const data = await response.json();
        if (!data.token) throw new Error("Token não encontrado na resposta do GAS.");
        return data.token;
    } catch (error) {
        console.error("Erro ao obter token:", error);
        throw new Error("Falha Crítica ao Obter Token de Autorização.");
    }
}

/**
 * Busca todas as guias OPME em "em-analise" (API 1).
 */
async function buscarGuiasOPME(token) {
    let todasGuias = [];
    let page = 0;
    let hasMore = true;

    // A API só retorna as guias em análise/reavaliação/documentação pendente
    const initialSize = 10; 

    while (hasMore) {
        const url = `${API_LISTA_BASE}?page=${page}&size=${initialSize}`;
        
        try {
            const response = await fetch(url, {
                headers: { 
                    'Authorization': `Bearer ${token}` 
                }
            });

            if (!response.ok) {
                // Se a API retornar 400 ou outro erro, paramos a busca.
                throw new Error(`Falha na API de lista inicial. Status: ${response.status}`);
            }

            const data = await response.json();
            
            if (data.content && data.content.length > 0) {
                todasGuias = todasGuias.concat(data.content);
                
                // Verifica se é a última página (melhor prática para paginação)
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


// Função para buscar detalhes de uma guia específica (API 2 e 3)
async function buscarDetalhesGuia(idGuia, token, tipoSegmento = '') {
    const url = `${API_BASE_URL}${idGuia}${tipoSegmento ? '/' + tipoSegmento : ''}`;
    
    try {
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            console.warn(`API Detalhe (ID: ${idGuia}) falhou com status: ${response.status}`);
            return null;
        }
        return await response.json();
    } catch (error) {
        console.error(`Erro na requisição da API Detalhe para ${idGuia}:`, error.message);
        return null;
    }
}

// Funções de formatação e classificação
function formatarStatus(status) {
    if (!status) return 'S/ Status';
    switch (status.toUpperCase()) {
        case 'AUTORIZADA': return 'Autorizada';
        case 'AUTORIZADA_PARCIALMENTE': return 'Parcialmente Autorizada';
        case 'NEGADA': case 'NEGADA_PARCIALMENTE': return 'Negada';
        case 'EM_ANALISE': case 'EM_REANALISE': case 'DOCUMENTACAO_EM_ANALISE': case 'AGUARDANDO_NO_PRAZO': case 'PENDENTE': return 'Em Análise';
        default: return status.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
    }
}

function formatarTipoGuia(tipo) {
    if (!tipo) return 'S/ Tipo';
    switch (tipo.toUpperCase()) {
        case 'SOLICITACAO_DE_OPME': return 'OPME';
        case 'SOLICITACAO_INTERNACAO': return 'Internação';
        default: return tipo.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
    }
}

function getStatusKey(statusOrigem, idGuiaOrigem) {
    if (idGuiaOrigem === 'N/A' || statusOrigem.includes('ERRO') || statusOrigem.includes('NÃO ENCONTRADA')) {
        return 'semGuiaOrigem';
    }
    
    switch (statusOrigem) {
        case 'Autorizada': return 'autorizadas';
        case 'Parcialmente Autorizada': return 'parcialmenteAutorizadas';
        case 'Negada': return 'negadas';
        default: return 'emAnalise';
    }
}

// --- ROTA PRINCIPAL (SSE) ---

app.get('/api/guias-opme-progress', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        // 1. Obter Token
        sendEvent({ type: 'progress', percent: 5, message: 'Obtendo token de autenticação...' });
        const token = await obterToken();
        if (!token) throw new Error('Não foi possível obter o token de autenticação.');

        // 2. Buscar Lista Inicial de Guias OPME (API 1)
        sendEvent({ type: 'progress', percent: 15, message: 'Buscando lista inicial de guias OPME...' });
        const guiasOPME = await buscarGuiasOPME(token);
        const total = guiasOPME.length;
        
        sendEvent({ type: 'progress', percent: 25, message: `Encontradas ${total} guias OPME para processar` });

        const resultados = {
            autorizadas: [],
            parcialmenteAutorizadas: [],
            negadas: [],
            emAnalise: [],
            semGuiaOrigem: []
        };
        
        // 3. Processar cada guia
        for (let i = 0; i < guiasOPME.length; i++) {
            const guiaOPME = guiasOPME[i];
            const percentBase = 25;
            const percent = percentBase + ((i + 1) / total * 70);
            
            let resultado = {
                guiaOPME: guiaOPME.idGuia,
                beneficiario: guiaOPME.beneficiario,
                prestador: guiaOPME.prestador,
                statusOPME: formatarStatus(guiaOPME.statusRegulacao),
                guiaOrigem: 'N/A',
                tipoGuiaOrigem: formatarTipoGuia(guiaOPME.tipoDeGuia),
                statusOrigem: 'NÃO ENCONTRADA',
                itensOrigem: []
            };

            sendEvent({ 
                type: 'progress', 
                percent: Math.round(percent), 
                message: `Processando guia ${i + 1} de ${total}: ${guiaOPME.idGuia}` 
            });

            try {
                // API 2: Detalhe OPME (para obter a guiaOrigem)
                const detalhesOPME = await buscarDetalhesGuia(guiaOPME.idGuia, token, 'OPME');
                
                if (detalhesOPME?.guia?.guiaOrigem?.id) {
                    const idGuiaOrigem = detalhesOPME.guia.guiaOrigem.id;
                    resultado.guiaOrigem = idGuiaOrigem;

                    // API 3: Detalhe da Guia de Origem
                    const detalhesOrigem = await buscarDetalhesGuia(idGuiaOrigem, token);
                    
                    if (detalhesOrigem?.guia) {
                        resultado.statusOrigem = formatarStatus(detalhesOrigem.guia.statusGuia.name);
                        resultado.tipoGuiaOrigem = formatarTipoGuia(detalhesOrigem.guia.tipoDeGuia);
                        
                        // Mapear Itens da Guia de Origem
                        if(detalhesOrigem.guia.itensGuia) {
                            resultado.itensOrigem = detalhesOrigem.guia.itensGuia.map(item => ({
                                codigo: item.codigo || 'S/C',
                                descricao: item.descricao,
                                quantSolicitada: item.quantSolicitada || 0,
                                quantAutorizada: item.regulacaoItemGuiaDto?.quantidadeAutorizada || 0,
                            }));
                        }
                    } else {
                        resultado.statusOrigem = 'ERRO AO BUSCAR DETALHE';
                    }
                }
            } catch (error) {
                resultado.statusOrigem = `ERRO: ${error.message.substring(0, 50)}...`;
                resultado.guiaOrigem = 'ERRO API';
            }

            // Classificar o resultado final
            const statusKey = getStatusKey(resultado.statusOrigem, resultado.guiaOrigem);
            resultados[statusKey].push(resultado);
            
            // Pequeno delay para não sobrecarregar a API
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        // 4. Conclusão
        sendEvent({ type: 'progress', percent: 98, message: 'Finalizando processamento...' });
        await new Promise(resolve => setTimeout(resolve, 500)); 

        sendEvent({ type: 'complete', resultados: resultados });
        console.log('Processamento concluído com sucesso!');
        res.end();
        
    } catch (error) {
        console.error('Erro no processamento SSE:', error);
        sendEvent({ type: 'error', message: error.message });
        res.end();
    }
});


// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`Abra http://localhost:${PORT} no seu navegador.`);
});
