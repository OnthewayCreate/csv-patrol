import React, { useState, useEffect, useRef } from 'react';
import { Upload, FileText, CheckCircle, Play, Download, Loader2, ShieldAlert, Pause, Trash2, Eye, Zap, FolderOpen, Lock, LogOut, History, Settings, Save, AlertTriangle, RefreshCw, Layers, Siren, Scale, SearchCheck, Activity, Cpu, Key, Ban, RotateCcw, Stethoscope, Check, X, Edit3 } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc, query, orderBy, limit, onSnapshot, serverTimestamp } from 'firebase/firestore';

// ==========================================
// 定数・設定
// ==========================================
const FIXED_PASSWORD = 'admin123';

const RISK_MAP = {
  'Critical': { label: '危険', color: 'bg-rose-100 text-rose-800 border-rose-200 ring-1 ring-rose-300' }, 
  'High': { label: '高', color: 'bg-red-100 text-red-800 border-red-200' },     
  'Medium': { label: '中', color: 'bg-yellow-100 text-yellow-800 border-yellow-200' }, 
  'Low': { label: '低', color: 'bg-green-100 text-green-800 border-green-200' },
  'Error': { label: 'エラー', color: 'bg-gray-200 text-gray-800 border-gray-300' }
};

const MODELS = [
  { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash (推奨・安定)' },
  { id: 'gemini-1.5-flash-001', name: 'Gemini 1.5 Flash-001 (安定版)' },
  { id: 'gemini-1.5-flash-002', name: 'Gemini 1.5 Flash-002 (最新安定版)' },
  { id: 'gemini-1.5-flash-8b', name: 'Gemini 1.5 Flash-8B (超高速)' },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro (高精度)' },
  { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash Exp (実験的)' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (ダッシュボード表示用)' }, 
];

const DEFAULT_MODEL = 'gemini-1.5-flash';

// ==========================================
// 1. ユーティリティ
// ==========================================
const parseCSV = (text) => {
  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];
    if (char === '"') {
      if (inQuotes && nextChar === '"') { currentField += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (char === ',' && !inQuotes) {
      currentRow.push(currentField); currentField = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') i++;
      currentRow.push(currentField); currentField = '';
      if (currentRow.length > 0) rows.push(currentRow);
      currentRow = [];
    } else { currentField += char; }
  }
  if (currentField || currentRow.length > 0) { currentRow.push(currentField); rows.push(currentRow); }
  return rows;
};

const readFileAsText = (file, encoding) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = (e) => reject(e);
    reader.readAsText(file, encoding);
  });
};

const cleanJson = (text) => {
  try {
    let cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start !== -1 && end !== -1) return cleaned.substring(start, end + 1);
    const startObj = cleaned.indexOf('{');
    const endObj = cleaned.lastIndexOf('}');
    if (startObj !== -1 && endObj !== -1) return cleaned.substring(startObj, endObj + 1);
    return cleaned;
  } catch (e) { return text; }
};

const parseKeys = (text) => {
  if (!text) return [];
  return text.split(/[\n, ]+/)
    .map(k => k.trim())
    .filter(k => k.length > 10 && k.startsWith('AIza')); 
};

// ==========================================
// 2. API呼び出し関数
// ==========================================

async function checkIPRiskBulkWithRotation(products, availableKeys, setAvailableKeys, modelId, isFallback = false) {
  if (availableKeys.length === 0) {
    throw new Error("ALL_KEYS_DEAD: 有効なAPIキーがありません");
  }

  const apiKey = availableKeys[Math.floor(Math.random() * availableKeys.length)];
  const productsListText = products.map(p => `ID:${p.id} 商品名:${p.name}`).join('\n');
  const systemInstruction = `
あなたはECモールの「知的財産権・薬機法・安全管理」の【鬼検閲官】です。
入力された商品リストを審査し、リスク判定を行ってください。
見逃し厳禁です。

【判定ロジック】
1. **🚨 Critical (危険)**: 銃器・武器類似品、アダルト、違法物。
2. **🔴 High (高)**: 偽ブランド、著作権侵害、薬機法（断定表現）。
3. **🟡 Medium (中)**: 互換品、景表法（最大級表現）、化粧品（逸脱）。
4. **🟢 Low (低)**: 安全な一般名詞。

【出力形式】
JSON配列のみ:
[{"id": ID, "risk_level": "Critical/High/Medium/Low", "reason": "短い理由"}, ...]
`;

  const currentModelId = isFallback ? DEFAULT_MODEL : (modelId || DEFAULT_MODEL);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${currentModelId}:generateContent?key=${apiKey}`;
  
  const payload = {
    contents: [{ parts: [{ text: `以下の商品を一括判定せよ:\n${productsListText}` }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: { responseMimeType: "application/json" }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    // 404: モデルエラー -> デフォルトモデルでリトライ
    if (response.status === 404) {
      if (!isFallback && currentModelId !== DEFAULT_MODEL) {
        console.warn(`モデル(${currentModelId})404エラー。標準(${DEFAULT_MODEL})でリトライします。`);
        return checkIPRiskBulkWithRotation(products, availableKeys, setAvailableKeys, DEFAULT_MODEL, true);
      }
    }

    if (response.status === 404 || response.status === 400 || response.status === 403) {
      console.warn(`不良キー検知(${response.status})。除外してリトライ: ${apiKey.slice(0, 5)}...`);
      const newKeys = availableKeys.filter(k => k !== apiKey);
      if (setAvailableKeys) setAvailableKeys(newKeys);
      return checkIPRiskBulkWithRotation(products, newKeys, setAvailableKeys, currentModelId, isFallback);
    }

    if (response.status === 429) {
      const waitTime = 2000 + Math.random() * 3000;
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return checkIPRiskBulkWithRotation(products, availableKeys, setAvailableKeys, currentModelId, isFallback);
    }
    
    if (!response.ok) throw new Error(`API Error: ${response.status}`);
    
    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error("No response content");
    
    const cleanText = cleanJson(rawText);
    const parsedResults = JSON.parse(cleanText);
    if (!Array.isArray(parsedResults)) throw new Error("Not an array");

    const resultMap = {};
    parsedResults.forEach(item => {
      let risk = item.risk_level;
      if (['危険', 'Critical'].includes(risk)) risk = 'Critical';
      else if (['高', 'High'].includes(risk)) risk = 'High';
      else if (['中', 'Medium'].includes(risk)) risk = 'Medium';
      else risk = 'Low';
      resultMap[item.id] = { risk, reason: item.reason };
    });
    return resultMap;

  } catch (error) {
    if (error.message.includes("ALL_KEYS_DEAD")) throw error;
    console.error("Bulk Check Error:", error);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const errorMap = {};
    products.forEach(p => {
      errorMap[p.id] = { risk: "Error", reason: error.message };
    });
    return errorMap;
  }
}

async function checkIPRiskDetailWithRotation(product, availableKeys, setAvailableKeys, modelId, isFallback = false) {
  if (availableKeys.length === 0) return { risk: product.risk, detail: "APIキー切れ" };
  
  const apiKey = availableKeys[Math.floor(Math.random() * availableKeys.length)];
  const currentModelId = isFallback ? DEFAULT_MODEL : (modelId || DEFAULT_MODEL);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${currentModelId}:generateContent?key=${apiKey}`;
  
  const systemInstruction = `あなたは知的財産権弁護士です。以下の商品のリスクを再鑑定し、JSONで出力してください。`;
  const payload = {
    contents: [{ parts: [{ text: `商品名: ${product.productName}, 一次判定: ${product.risk}, 理由: ${product.reason}` }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: { responseMimeType: "application/json" }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (response.status === 404) {
       if (!isFallback && currentModelId !== DEFAULT_MODEL) {
         return checkIPRiskDetailWithRotation(product, availableKeys, setAvailableKeys, DEFAULT_MODEL, true);
       }
    }

    if (response.status === 404 || response.status === 400 || response.status === 403) {
      const newKeys = availableKeys.filter(k => k !== apiKey);
      if (setAvailableKeys) setAvailableKeys(newKeys);
      return checkIPRiskDetailWithRotation(product, newKeys, setAvailableKeys, currentModelId, isFallback);
    }

    if (response.status === 429) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      return checkIPRiskDetailWithRotation(product, availableKeys, setAvailableKeys, currentModelId, isFallback);
    }
    
    if (!response.ok) throw new Error(`API Error: ${response.status}`);
    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    const result = JSON.parse(cleanJson(rawText));
    
    let risk = result.final_risk;
    if (['危険', 'Critical'].includes(risk)) risk = 'Critical';
    else if (['高', 'High'].includes(risk)) risk = 'High';
    else if (['中', 'Medium'].includes(risk)) risk = 'Medium';
    else risk = 'Low';

    return { risk, detail: result.detailed_analysis };

  } catch (error) {
    return { risk: product.risk, detail: `分析不可: ${error.message}` };
  }
}

// ==========================================
// 3. メインコンポーネント
// ==========================================
export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [inputPassword, setInputPassword] = useState('');
  
  const [apiKeysText, setApiKeysText] = useState('');
  const [activeKeys, setActiveKeys] = useState([]); 
  const [keyStatuses, setKeyStatuses] = useState({}); 
  
  const [firebaseConfigJson, setFirebaseConfigJson] = useState('');
  const [modelId, setModelId] = useState(DEFAULT_MODEL);
  const [customModelId, setCustomModelId] = useState(''); 
  const [db, setDb] = useState(null);
  
  const [activeTab, setActiveTab] = useState('checker');
  const [files, setFiles] = useState([]);
  const [csvData, setCsvData] = useState([]);
  const [headers, setHeaders] = useState([]);
  const [targetColIndex, setTargetColIndex] = useState(-1);
  
  const [results, setResults] = useState([]);
  const [historyData, setHistoryData] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDetailAnalyzing, setIsDetailAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  
  const [statusState, setStatusState] = useState({
    message: '待機中',
    successCount: 0,
    errorCount: 0,
    currentBatch: 0,
    totalBatches: 0,
    deadKeysCount: 0 
  });

  const [encoding, setEncoding] = useState('Shift_JIS');
  const [isHighSpeed, setIsHighSpeed] = useState(true); 
  const stopRef = useRef(false);

  useEffect(() => {
    const savedKeys = localStorage.getItem('gemini_api_keys'); 
    const savedFbConfig = localStorage.getItem('firebase_config');
    const savedModel = localStorage.getItem('gemini_model');
    const savedCustomModel = localStorage.getItem('gemini_custom_model');
    const legacyKey = localStorage.getItem('gemini_api_key');
    
    if (savedKeys) {
      setApiKeysText(savedKeys);
      setActiveKeys(parseKeys(savedKeys));
    } else if (legacyKey) {
      setApiKeysText(legacyKey);
      setActiveKeys(parseKeys(legacyKey));
    }

    if (savedModel) setModelId(savedModel);
    if (savedCustomModel) setCustomModelId(savedCustomModel);
    
    if (savedFbConfig) {
      setFirebaseConfigJson(savedFbConfig);
      initFirebase(savedFbConfig);
    }
  }, []);

  // テキストエリア変更時にのみ同期。処理中の除外はここに反映させない
  useEffect(() => {
    setActiveKeys(parseKeys(apiKeysText));
  }, [apiKeysText]);

  const initFirebase = (configStr) => {
    try {
      const config = JSON.parse(configStr);
      const app = initializeApp(config);
      const firestore = getFirestore(app);
      setDb(firestore);
      const q = query(collection(firestore, 'ip_checks'), orderBy('createdAt', 'desc'), limit(50));
      onSnapshot(q, (snapshot) => {
        const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        setHistoryData(docs);
      });
    } catch (e) {
      console.warn("Firebase Init Warning:", e);
    }
  };

  const handleLogin = (e) => {
    e.preventDefault();
    if (inputPassword === FIXED_PASSWORD) {
      setIsAuthenticated(true);
    } else {
      alert("パスワードが違います");
    }
  };

  const saveSettings = () => {
    localStorage.setItem('gemini_api_keys', apiKeysText);
    localStorage.setItem('firebase_config', firebaseConfigJson);
    localStorage.setItem('gemini_model', modelId);
    localStorage.setItem('gemini_custom_model', customModelId);
    if (firebaseConfigJson) initFirebase(firebaseConfigJson);
    alert("設定を保存しました");
  };

  // 接続テスト (有効なキーだけを残してactiveKeysを更新する)
  const testConnection = async () => {
    const keys = parseKeys(apiKeysText);
    if (keys.length === 0) return alert("APIキーが入力されていません");
    
    setKeyStatuses({});
    let results = {};
    let validKeys = []; // 有効なキーのリスト
    
    const targetModel = modelId === 'custom' ? customModelId : modelId;

    for (const key of keys) {
      results[key] = { status: 'loading' };
      setKeyStatuses({...results});
      
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${key}`;
        let res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: "Hello" }] }] })
        });
        
        if (res.ok) {
          results[key] = { status: 'ok', msg: `接続OK` };
          validKeys.push(key);
        } else if (res.status === 404) {
          const fallbackUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;
          const resFallback = await fetch(fallbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: "Hello" }] }] })
          });
          
          if (resFallback.ok) {
             results[key] = { status: 'ok', msg: '1.5 Flashで接続OK' };
             validKeys.push(key);
          } else {
             results[key] = { status: 'error', msg: '無効なキー' };
          }
        } else {
          results[key] = { status: 'error', msg: `エラー: ${res.status}` };
        }
      } catch (e) {
        results[key] = { status: 'error', msg: '通信エラー' };
      }
      setKeyStatuses({...results});
    }
    
    // 接続テスト後は、有効なキーだけを稼働キーとしてセットする
    if (validKeys.length > 0) {
      setActiveKeys(validKeys);
    }
  };

  const saveToHistory = async (item) => {
    if (!db) return;
    try {
      if (['Critical', 'High', 'Medium'].includes(item.risk)) {
        await addDoc(collection(db, 'ip_checks'), {
          productName: item.productName,
          risk: item.risk,
          reason: item.detailedReason || item.reason, 
          sourceFile: item.sourceFile,
          createdAt: serverTimestamp()
        });
      }
    } catch (e) {
      console.error("Save Error", e);
    }
  };

  const handleFileUpload = async (e) => {
    const uploadedFiles = e.target.files ? Array.from(e.target.files) : [];
    if (uploadedFiles.length === 0) return;
    
    setFiles(prev => [...prev, ...uploadedFiles]);
    setResults([]); 

    let newRows = [];
    let commonHeaders = [];

    for (let i = 0; i < uploadedFiles.length; i++) {
      const file = uploadedFiles[i];
      try {
        const text = await readFileAsText(file, encoding);
        const parsed = parseCSV(text);
        if (parsed.length > 0) {
          const fileHeaders = parsed[0];
          const fileRows = parsed.slice(1);
          if (headers.length === 0 && i === 0) {
            commonHeaders = [...fileHeaders, "元ファイル名"];
            setHeaders(commonHeaders);
            const nameIndex = fileHeaders.findIndex(h => h.includes('商品名') || h.includes('Name') || h.includes('Product') || h.includes('名称'));
            setTargetColIndex(nameIndex !== -1 ? nameIndex : 0);
          }
          const rowsWithFileName = fileRows.map(row => [...row, file.name]); 
          newRows = [...newRows, ...rowsWithFileName];
        }
      } catch (err) { alert(`${file.name} の読み込みに失敗しました。エンコードを確認してください。`); }
    }
    setCsvData(prev => [...prev, ...newRows]);
  };

  const handleReset = () => {
    if (isProcessing && !confirm("処理を中断して初期化しますか？")) return;
    setFiles([]);
    setCsvData([]);
    setResults([]);
    setProgress(0);
    setStatusState({ 
      message: '待機中', 
      successCount: 0, 
      errorCount: 0, 
      currentBatch: 0, 
      totalBatches: 0, 
      deadKeysCount: 0 
    });
    setIsProcessing(false);
    setIsDetailAnalyzing(false);
    stopRef.current = true;
    setHeaders([]);
    setTargetColIndex(-1);
  };

  const startProcessing = async () => {
    // 修正: 開始時にAPIキーを強制リセットせず、現在有効なキー（activeKeys）を使用する
    // ただし、activeKeysが空の場合はテキストから再ロードする（初期状態対策）
    let currentKeys = activeKeys;
    if (currentKeys.length === 0 && apiKeysText) {
      currentKeys = parseKeys(apiKeysText);
      setActiveKeys(currentKeys);
    }

    if (currentKeys.length === 0) return alert("有効なAPIキーが設定されていません。設定画面でキーを確認するか、接続テストを行ってください。");
    if (csvData.length === 0) return;

    setIsProcessing(true);
    setIsDetailAnalyzing(false);
    stopRef.current = false;
    setResults([]); 
    setProgress(0);
    
    setStatusState({ 
      message: '初期化中...', 
      successCount: 0, 
      errorCount: 0, 
      currentBatch: 0, 
      totalBatches: 0, 
      deadKeysCount: parseKeys(apiKeysText).length - currentKeys.length
    });

    const BULK_SIZE = 30; 
    const CONCURRENCY = isHighSpeed ? 3 : 2;

    let currentIndex = 0;
    const total = csvData.length;
    const totalBatches = Math.ceil(total / BULK_SIZE);

    const initialJitter = Math.random() * 2000;
    await new Promise(resolve => setTimeout(resolve, initialJitter));

    const currentModelId = modelId === 'custom' ? customModelId : modelId;

    while (currentIndex < total) {
      if (stopRef.current) break;
      
      const tasks = [];
      const currentBatchNum = Math.floor(currentIndex / BULK_SIZE) + 1;
      
      setStatusState(prev => ({
        ...prev,
        message: `並列処理中... (${currentIndex}/${total}件)`,
        currentBatch: currentBatchNum,
        totalBatches: totalBatches,
        // アクティブキーの数をリアルタイム反映したいが、非同期State更新のためここでは近似値
      }));

      for (let c = 0; c < CONCURRENCY; c++) {
        const chunkStart = currentIndex + (c * BULK_SIZE);
        if (chunkStart >= total) break;
        const chunkEnd = Math.min(chunkStart + BULK_SIZE, total);
        
        const chunkProducts = [];
        for (let i = chunkStart; i < chunkEnd; i++) {
          const row = csvData[i];
          const productName = row[targetColIndex] || "不明な商品名";
          chunkProducts.push({
            id: i,
            name: productName.length > 500 ? productName.substring(0, 500) + "..." : productName,
            sourceFile: row[row.length - 1]
          });
        }
        
        if (chunkProducts.length > 0) {
          tasks.push(
            checkIPRiskBulkWithRotation(chunkProducts, activeKeys, setActiveKeys, currentModelId).then(resultMap => {
              return chunkProducts.map(p => ({
                id: p.id,
                productName: p.name,
                sourceFile: p.sourceFile,
                risk: resultMap[p.id]?.risk || "Error",
                reason: resultMap[p.id]?.reason || "判定失敗",
                detailedReason: null
              }));
            })
          );
        }
      }

      if (tasks.length > 0) {
        try {
          const chunkResults = await Promise.all(tasks);
          const flatResults = chunkResults.flat();
          
          const success = flatResults.filter(r => r.risk !== 'Error').length;
          const errors = flatResults.filter(r => r.risk === 'Error').length;
          
          setResults(prev => [...prev, ...flatResults]);
          setStatusState(prev => ({
            ...prev,
            successCount: prev.successCount + success,
            errorCount: prev.errorCount + errors
          }));

          currentIndex += tasks.reduce((acc, _, idx) => {
             const processedInTask = Math.min(currentIndex + ((idx + 1) * BULK_SIZE), total) - (currentIndex + (idx * BULK_SIZE));
             return acc + (processedInTask > 0 ? processedInTask : 0);
          }, 0);
          
          const nextProgress = Math.round((currentIndex / total) * 100);
          setProgress(nextProgress);

        } catch (e) {
          if (e.message.includes("ALL_KEYS_DEAD")) {
             alert("全てのAPIキーが無効になりました。設定画面で「接続テスト」を行い、有効なキーを確認してください。");
             break;
          }
          console.error("Batch error:", e);
          currentIndex += (CONCURRENCY * BULK_SIZE);
        }
      }

      const baseWait = isHighSpeed ? 300 : 1500;
      if (currentIndex < total) await new Promise(resolve => setTimeout(resolve, baseWait));
    }
    
    setProgress(100);
    setStatusState(prev => ({ ...prev, message: '一次審査完了' }));
    setIsProcessing(false);
  };

  const startDetailAnalysis = async () => {
    if (activeKeys.length === 0) return alert("有効なキーがありません");
    setIsDetailAnalyzing(true);
    stopRef.current = false;
    
    const riskyItems = results.filter(r => ['Critical', 'High', 'Medium'].includes(r.risk));
    const totalRisky = riskyItems.length;
    let newResults = [...results];
    const CONCURRENCY = 5;
    const currentModelId = modelId === 'custom' ? customModelId : modelId;
    
    setStatusState(prev => ({ ...prev, message: '詳細鑑定を開始します...', totalBatches: totalRisky, currentBatch: 0 }));

    for (let i = 0; i < totalRisky; i += CONCURRENCY) {
      if (stopRef.current) break;
      if (activeKeys.length === 0) break;
      
      const batch = riskyItems.slice(i, i + CONCURRENCY);
      setStatusState(prev => ({ ...prev, message: `詳細鑑定中 (${i + 1}/${totalRisky})`, currentBatch: i + 1 }));

      try {
        const promises = batch.map(item => {
          return checkIPRiskDetailWithRotation(item, activeKeys, setActiveKeys, currentModelId).then(res => ({
            id: item.id,
            finalRisk: res.risk,
            detail: res.detail
          }));
        });

        const batchResults = await Promise.all(promises);

        batchResults.forEach(res => {
          const index = newResults.findIndex(r => r.id === res.id);
          if (index !== -1) {
            newResults[index] = { ...newResults[index], risk: res.finalRisk, detailedReason: res.detail, isDetailed: true };
            saveToHistory(newResults[index]);
          }
        });
        setResults([...newResults]); 
        
      } catch (e) {
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    setIsDetailAnalyzing(false);
    setStatusState(prev => ({ ...prev, message: '全工程完了' }));
  };

  const downloadCSV = (dataToDownload, filterRisky = false) => {
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    let csvContent = "商品名,リスク判定,理由,詳細分析(AI弁護士),元ファイル名,判定日時\n";
    const data = filterRisky ? dataToDownload.filter(r => r.risk !== 'Low' && r.risk !== 'Error') : dataToDownload;
    if (data.length === 0) return alert("該当するデータがありません");

    data.forEach(r => {
      const riskLabel = RISK_MAP[r.risk]?.label || r.risk;
      const name = `"${(r.productName || '').replace(/"/g, '""')}"`;
      const reason = `"${(r.reason || '').replace(/"/g, '""')}"`;
      const detail = `"${(r.detailedReason || '').replace(/"/g, '""')}"`;
      const file = `"${(r.sourceFile || '').replace(/"/g, '""')}"`;
      const date = r.createdAt ? new Date(r.createdAt.seconds * 1000).toLocaleString() : new Date().toLocaleString();
      csvContent += `${name},${riskLabel},${reason},${detail},${file},${date}\n`;
    });
    const blob = new Blob([bom, csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `ip_check_result.csv`);
    document.body.appendChild(link);
    link.click(); document.body.removeChild(link);
  };

  const RiskBadge = ({ risk }) => {
    const config = RISK_MAP[risk] || RISK_MAP['Error'];
    return <span className={`px-3 py-1 rounded-full text-xs font-bold border whitespace-nowrap ${config.color}`}>{risk === 'Critical' && <Siren className="w-3 h-3 inline mr-1 mb-0.5" />}{config.label}</span>;
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <div className="bg-white p-16 rounded-2xl shadow-2xl w-full max-w-5xl transition-all border border-slate-200">
          <div className="flex flex-col items-center">
            <div className="bg-blue-50 p-6 rounded-full mb-8"><Lock className="w-16 h-16 text-blue-600" /></div>
            <h1 className="text-4xl font-extrabold text-center text-slate-800 mb-3 tracking-tight">IP Patrol Pro</h1>
            <span className="text-sm font-bold bg-indigo-100 text-indigo-700 px-4 py-1.5 rounded-full mb-10">鬼バルクモード搭載</span>
          </div>
          <form onSubmit={handleLogin} className="space-y-8 max-w-xl mx-auto"> 
            <div>
              <label className="block text-sm font-bold text-slate-600 mb-2">パスワード</label>
              <input type="password" value={inputPassword} onChange={(e) => setInputPassword(e.target.value)} className="w-full px-6 py-4 border border-slate-300 rounded-xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 outline-none transition-all text-lg" placeholder="パスワードを入力" autoFocus />
            </div>
            <button type="submit" className="w-full bg-blue-600 text-white py-4 rounded-xl font-bold text-xl hover:bg-blue-700 shadow-xl shadow-blue-200 transition-all active:scale-95">ログインして開始</button>
          </form>
          <p className="text-center text-xs text-slate-400 mt-12 font-mono">Authorized Personnel Only</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-800">
      <nav className="bg-white border-b border-slate-200 sticky top-0 z-20 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-slate-800 text-lg">
            <ShieldAlert className="w-7 h-7 text-blue-600" />
            <span>IP Patrol Pro <span className="text-xs font-normal text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full ml-1">鬼バルクモード</span></span>
          </div>
          <div className="flex items-center gap-1">
            {['checker', 'history', 'settings'].map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === tab ? 'bg-blue-50 text-blue-600' : 'text-slate-500 hover:bg-slate-50'}`}>
                {tab === 'checker' ? 'チェック' : tab === 'history' ? '履歴' : '設定'}
              </button>
            ))}
            <button onClick={() => setIsAuthenticated(false)} className="ml-2 p-2 text-slate-400 hover:text-red-500"><LogOut className="w-5 h-5" /></button>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto p-4 md:p-6">
        {activeTab === 'checker' && (
          <div className="space-y-6 animate-in fade-in duration-300">
            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
                <div className={`p-4 rounded-lg border flex items-center gap-3 bg-slate-50 border-slate-200`}>
                  <Activity className="w-5 h-5 text-blue-600" />
                  <div className="w-full">
                    <p className="text-xs text-slate-500 font-bold">ステータス</p>
                    <p className="text-sm font-bold truncate w-full text-slate-700">{statusState.message}</p>
                  </div>
                </div>
                <div className="p-4 rounded-lg border bg-green-50 border-green-200 flex items-center gap-3">
                  <CheckCircle className="w-5 h-5 text-green-600" />
                  <div>
                    <p className="text-xs text-green-600 font-bold">成功件数</p>
                    <p className="text-xl font-bold text-green-700">{statusState.successCount}</p>
                  </div>
                </div>
                <div className="p-4 rounded-lg border bg-blue-50 border-blue-200 flex items-center gap-3">
                  <Key className="w-5 h-5 text-blue-600" />
                  <div>
                    <p className="text-xs text-blue-600 font-bold">稼働キー数</p>
                    <p className="text-xl font-bold text-blue-700">{activeKeys.length} <span className="text-xs font-normal">/ {parseKeys(apiKeysText).length}</span></p>
                  </div>
                </div>
                <div className="p-4 rounded-lg border bg-rose-50 border-rose-200 flex items-center gap-3">
                  <Ban className="w-5 h-5 text-rose-600" />
                  <div>
                    <p className="text-xs text-rose-600 font-bold">排除キー数</p>
                    <p className="text-xl font-bold text-rose-700">{parseKeys(apiKeysText).length - activeKeys.length}</p>
                  </div>
                </div>
              </div>

              <div className="flex flex-col lg:flex-row gap-6">
                <div className="flex-1">
                  <div className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center hover:bg-blue-50 transition-colors relative cursor-pointer min-h-[160px] flex flex-col items-center justify-center group">
                    <input type="file" accept=".csv" multiple onChange={handleFileUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
                    <FolderOpen className="w-10 h-10 text-slate-400 mb-3 group-hover:text-blue-500 transition-colors" />
                    <p className="text-base font-bold text-slate-700">CSVファイルをここにドロップ（複数可）</p>
                    <p className="text-xs text-slate-500 mt-1">またはクリックしてファイルを選択</p>
                  </div>
                  {files.length > 0 && (
                    <div className="mt-4 bg-slate-50 rounded-lg p-3 border border-slate-100 flex justify-between items-center">
                      <span className="text-xs font-bold text-slate-600">読み込み済み: {files.length}ファイル ({csvData.length}件)</span>
                      <button onClick={handleReset} className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1"><Trash2 className="w-3 h-3" /> 全削除</button>
                    </div>
                  )}
                </div>

                <div className="w-full lg:w-80 space-y-4">
                  <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
                    <h3 className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-2"><Settings className="w-4 h-4" /> 読込オプション</h3>
                    <div className="space-y-3">
                      <select value={encoding} onChange={(e) => setEncoding(e.target.value)} className="w-full px-3 py-2 border rounded bg-white text-sm">
                        <option value="Shift_JIS">Shift_JIS (楽天/Excel)</option>
                        <option value="UTF-8">UTF-8 (一般/Web)</option>
                      </select>
                      <select value={targetColIndex} onChange={(e) => setTargetColIndex(Number(e.target.value))} className="w-full px-3 py-2 border rounded bg-white text-sm" disabled={headers.length === 0}>
                        {headers.length === 0 && <option>ファイルを読み込んでください</option>}
                        {headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                      </select>
                    </div>
                  </div>
                  <div onClick={() => setIsHighSpeed(!isHighSpeed)} className={`p-4 rounded-lg border cursor-pointer transition-all ${isHighSpeed ? 'bg-indigo-50 border-indigo-200 ring-2 ring-indigo-100' : 'bg-white border-slate-200'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2"><Layers className={`w-5 h-5 ${isHighSpeed ? 'text-indigo-600' : 'text-slate-400'}`} /><span className={`font-bold text-sm ${isHighSpeed ? 'text-indigo-900' : 'text-slate-600'}`}>鬼バルクモード</span></div>
                      <div className={`w-10 h-5 rounded-full relative transition-colors ${isHighSpeed ? 'bg-indigo-600' : 'bg-slate-300'}`}><div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-transform ${isHighSpeed ? 'left-6' : 'left-1'}`} /></div>
                    </div>
                    <p className="text-xs text-slate-500">見逃し厳禁・鬼検閲官による一括判定。疑わしいものは全て警告します。</p>
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-slate-100">
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                      <span>{statusState.message}</span>
                      <span>{progress}%</span>
                    </div>
                    <div className="bg-slate-100 rounded-full h-3 overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-blue-500 to-indigo-600 transition-all duration-300" style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                  
                  {!isProcessing && !isDetailAnalyzing ? (
                    <div className="flex items-center gap-2">
                      {results.length > 0 ? (
                        <button onClick={handleReset} className="flex items-center gap-2 px-8 py-3 bg-slate-600 hover:bg-slate-700 text-white font-bold rounded-lg shadow-md transition-transform active:scale-95 whitespace-nowrap"><RotateCcw className="w-5 h-5" /> 次のファイルをチェック</button>
                      ) : (
                        <button onClick={startProcessing} disabled={files.length === 0} className="flex items-center gap-2 px-8 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white font-bold rounded-lg shadow-md transition-transform active:scale-95 whitespace-nowrap"><Play className="w-5 h-5" /> 一次審査開始</button>
                      )}
                    </div>
                  ) : (
                    <button onClick={() => {stopRef.current = true; setIsProcessing(false); setIsDetailAnalyzing(false); setStatusState(p => ({...p, message: '停止しました'}));}} className="flex items-center gap-2 px-8 py-3 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg shadow-md transition-transform active:scale-95 whitespace-nowrap"><Pause className="w-5 h-5" /> 一時停止</button>
                  )}
                </div>
              </div>
            </div>

            {/* ダブルチェックアクション */}
            {results.filter(r => ['Critical', 'High', 'Medium'].includes(r.risk)).length > 0 && !isProcessing && (
              <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-6 flex flex-col md:flex-row items-center justify-between gap-4 animate-in slide-in-from-top-2">
                <div className="flex items-start gap-3">
                  <div className="bg-indigo-100 p-2 rounded-lg text-indigo-600"><Scale className="w-6 h-6" /></div>
                  <div>
                    <h3 className="font-bold text-indigo-900">AI弁護士によるダブルチェック</h3>
                    <p className="text-sm text-indigo-700 mt-1">リスクあり商品を専門家AIが再鑑定します。</p>
                  </div>
                </div>
                {!isDetailAnalyzing ? (
                  <button onClick={startDetailAnalysis} className="flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-lg shadow-lg shadow-indigo-200 transition-all active:scale-95 whitespace-nowrap"><SearchCheck className="w-5 h-5" /> 詳細鑑定を実行</button>
                ) : (
                   <div className="flex items-center gap-2 text-indigo-600 font-bold px-4"><Loader2 className="w-5 h-5 animate-spin" /> 鑑定中...</div>
                )}
              </div>
            )}

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col h-[600px]">
              <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50 shrink-0">
                <div className="flex items-center gap-3">
                  <h2 className="font-bold text-slate-700 flex items-center gap-2"><CheckCircle className="w-5 h-5 text-green-600" /> 判定結果 ({results.length}件)</h2>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => downloadCSV(results, true)} disabled={results.length === 0} className="px-4 py-2 bg-red-50 border border-red-200 hover:bg-red-100 text-red-700 rounded-lg text-sm font-medium flex items-center gap-2 shadow-sm disabled:opacity-50 transition-colors"><Download className="w-4 h-4" /> リスクありのみ保存</button>
                  <button onClick={() => downloadCSV(results, false)} disabled={results.length === 0} className="px-4 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg text-sm font-medium flex items-center gap-2 shadow-sm disabled:opacity-50"><Download className="w-4 h-4" /> 全件保存</button>
                </div>
              </div>
              <div className="flex-1 overflow-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-slate-500 uppercase bg-slate-50 sticky top-0 z-10 shadow-sm">
                    <tr><th className="px-4 py-3 w-28 text-center">判定</th><th className="px-4 py-3 w-1/3">商品名</th><th className="px-4 py-3">指摘理由・リスク要因</th><th className="px-4 py-3 w-32">元ファイル</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {results.map((item, idx) => (
                      <tr key={idx} className={`hover:bg-slate-50 transition-colors ${item.risk === 'Critical' ? 'bg-rose-50' : ''}`}>
                        <td className="px-4 py-3 text-center"><RiskBadge risk={item.risk} />{item.isDetailed && <div className="mt-1 text-[10px] text-indigo-600 font-bold border border-indigo-200 bg-indigo-50 rounded px-1">鑑定済</div>}</td>
                        <td className="px-4 py-3"><div className="font-medium text-slate-700 line-clamp-2" title={item.productName}>{item.productName}</div></td>
                        <td className="px-4 py-3">
                          <div className={`text-xs mb-1 ${item.risk === 'Critical' ? 'text-rose-700 font-bold' : item.risk === 'High' ? 'text-red-600 font-bold' : 'text-slate-600'}`}>{item.reason}</div>
                          {item.detailedReason && <div className="text-xs text-indigo-700 bg-indigo-50 p-2 rounded border border-indigo-100 mt-1"><span className="font-bold mr-1">【弁護士AI】</span>{item.detailedReason}</div>}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-400 truncate max-w-[150px]" title={item.sourceFile}>{item.sourceFile}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* --- 設定画面 --- */}
        {activeTab === 'settings' && (
          <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in">
            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
              <h2 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2"><Settings className="w-5 h-5" /> アプリ設定</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">使用するAIモデル</label>
                  <select value={modelId} onChange={(e) => setModelId(e.target.value)} className="w-full px-4 py-2 border rounded-lg bg-white">
                    {MODELS.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                    <option value="custom">カスタムモデル (手動入力)</option>
                  </select>
                  {modelId === 'custom' && (
                    <div className="mt-2 flex items-center gap-2">
                      <Edit3 className="w-4 h-4 text-slate-400" />
                      <input 
                        type="text" 
                        value={customModelId} 
                        onChange={(e) => setCustomModelId(e.target.value)} 
                        className="flex-1 px-3 py-2 border rounded text-sm" 
                        placeholder="例: gemini-1.5-flash-002" 
                      />
                    </div>
                  )}
                  <p className="text-xs text-slate-500 mt-1">404エラーが出る場合はモデルを変更してください。</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Gemini API Keys (複数登録推奨)</label>
                  <textarea 
                    value={apiKeysText} 
                    onChange={(e) => setApiKeysText(e.target.value)} 
                    className="w-full px-4 py-2 border rounded-lg bg-slate-50 h-32 font-mono text-sm" 
                    placeholder={`AIza...\nAIza...\nAIza...\n(キーを改行区切りで複数入力すると、負荷分散モードが作動します)`}
                  />
                  <div className="flex justify-between items-start mt-2">
                    <p className="text-xs text-slate-500">複数入力すると、エラーが出たキーを自動で排除して処理を継続します。<br/><span className="text-green-600 font-bold">APIキー接続テストボタンでキーの有効性を確認してください。</span></p>
                    <button onClick={testConnection} className="flex items-center gap-1 px-3 py-1 bg-green-50 text-green-700 border border-green-200 rounded text-xs font-bold hover:bg-green-100 transition-colors whitespace-nowrap"><Stethoscope className="w-3 h-3" /> APIキー接続テスト</button>
                  </div>
                  
                  {/* キーのステータス表示 */}
                  {Object.keys(keyStatuses).length > 0 && (
                    <div className="mt-2 space-y-1 p-2 bg-slate-50 rounded border border-slate-200 max-h-32 overflow-y-auto">
                      {Object.entries(keyStatuses).map(([key, status], idx) => (
                        <div key={idx} className="flex items-center gap-2 text-xs font-mono">
                          {status.status === 'loading' && <Loader2 className="w-3 h-3 animate-spin text-slate-400" />}
                          {status.status === 'ok' && <Check className="w-3 h-3 text-green-600" />}
                          {status.status === 'error' && <X className="w-3 h-3 text-red-600" />}
                          <span className="text-slate-500">{key.slice(0, 8)}...</span>
                          <span className={status.status === 'ok' ? 'text-green-600' : status.status === 'error' ? 'text-red-600' : 'text-slate-400'}>{status.msg}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Firebase Config (JSON)</label>
                  <textarea value={firebaseConfigJson} onChange={(e) => setFirebaseConfigJson(e.target.value)} className="w-full px-4 py-2 border rounded-lg bg-slate-50 h-32 text-xs font-mono" />
                </div>
                <div className="pt-4">
                  <button onClick={saveSettings} className="flex items-center justify-center gap-2 w-full bg-indigo-600 text-white font-bold py-2 rounded-lg hover:bg-indigo-700 shadow-sm"><Save className="w-4 h-4" /> 設定を保存</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}