import React, { useState, useEffect, useRef } from 'react';
import { Upload, FileText, CheckCircle, Play, Download, Loader2, ShieldAlert, Pause, Trash2, Eye, Zap, FolderOpen, Lock, LogOut, History, Settings, Save, AlertTriangle, RefreshCw, Layers, Siren, Scale, SearchCheck } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc, query, orderBy, limit, onSnapshot, serverTimestamp } from 'firebase/firestore';

// ==========================================
// 定数・設定
// ==========================================
const FIXED_PASSWORD = 'admin123';

// リスク表示用の変換マップ
const RISK_MAP = {
  'Critical': { label: '危険', color: 'bg-rose-100 text-rose-800 border-rose-200 ring-1 ring-rose-300' }, // モラル・安全性
  'High': { label: '高', color: 'bg-red-100 text-red-800 border-red-200' },     // 知財・薬機法（重）
  'Medium': { label: '中', color: 'bg-yellow-100 text-yellow-800 border-yellow-200' }, // 疑わしい・薬機法（軽）
  'Low': { label: '低', color: 'bg-green-100 text-green-800 border-green-200' },
  'Error': { label: 'エラー', color: 'bg-gray-200 text-gray-800 border-gray-300' }
};

// ==========================================
// 1. ユーティリティ関数
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

// AIのレスポンスからJSON部分だけを抽出するクリーニング関数
const cleanJson = (text) => {
  try {
    // Markdownのコードブロック記号を削除
    let cleaned = text.replace(/```json/g, '').replace(/```/g, '');
    cleaned = cleaned.trim();
    // 配列の開始と終了を探して抽出
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start !== -1 && end !== -1) {
      return cleaned.substring(start, end + 1);
    }
    return cleaned;
  } catch (e) {
    return text;
  }
};

// ==========================================
// 2. API呼び出し関数
// ==========================================

/**
 * 1. 一次審査: 複数の商品を一度に判定するバルク処理
 * 「見逃し厳禁」モード + 堅牢なエラーハンドリング
 */
async function checkIPRiskBulk(products, apiKey, retryCount = 0) {
  // 入力リストの作成
  const productsListText = products.map(p => `ID:${p.id} 商品名:${p.name}`).join('\n');

  const systemInstruction = `
あなたはECモールの「知的財産権・薬機法・安全管理」の【鬼検閲官】です。
入力された商品リストを審査し、リスク判定を行ってください。

【最重要司令: 見逃しは許されない】
あなたは「安全な商品を通過させる」ことではなく、**「少しでも怪しい商品を摘発する」**ことが仕事です。
**「過剰検知（False Positive）」は許されますが、「見逃し（False Negative）」は一切許されません。**
1%でも疑わしい要素があれば、躊躇なく **Medium** 以上をつけて警告してください。

【厳格な判定ロジック】

1. **🚨 Critical (危険/禁止)**
   - 銃器類（モデルガン、エアガン含む）、刀剣、ボウガン等の武器類似品。
   - アダルト、性的な隠語、差別、暴力表現。
   - 違法薬物、爆発物を示唆するもの。

2. **🔴 High (高リスク: ほぼクロ)**
   - **パロディ・模倣**: 「〇〇風」「〇〇タイプ」「〇〇調」「〇〇スタイル」という言葉があり、ブランド名やキャラ名が続く場合。
   - **偽ブランド**: 有名ブランド名（Nike, Chanel, Disney, ポケモン等）があるが、「公式」「純正」「中古」等の正当性を示す言葉がない、または価格が安すぎることを示唆する文脈（激安、訳あり等）。
   - **薬機法（断定）**: 「ガンが治る」「必ず痩せる」「育毛」「白髪が黒くなる」など、身体的変化・治療を断定する表現。

3. **🟡 Medium (中リスク: 要目視確認)**
   - **互換品の疑い**: 「〇〇対応」「for 〇〇」とあるが、純正品と誤認しやすい表記。
   - **景品表示法（誇大）**: 「世界一」「最強」「No.1」「神効果」「激ヤセ」などの根拠なき強調。
   - **化粧品・健康食品の暗示**: 「デトックス」「アンチエイジング」「若返り」「免疫力」「血液サラサラ」など、医薬品的な効果を暗示する表現。

4. **🟢 Low (低リスク)**
   - 上記のいずれにも該当せず、一般名詞のみで構成され、完全に安全であると断言できるもののみ。

【思考プロセス】
各商品に対し、まず「High」か「Medium」の理由を探してください。
理由が全く見つからない場合のみ、「Low」としてください。

【出力形式】
JSON配列のみを出力してください。Markdown記法は不要です。
[
  {"id": 入力されたID, "risk_level": "Critical/High/Medium/Low", "reason": "短い日本語での指摘(なぜ疑ったか)"},
  ...
]
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`;
  
  const payload = {
    contents: [{ parts: [{ text: `以下の商品リストを【厳格に】一括判定せよ。迷ったらMediumにせよ。\n${productsListText}` }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: { 
      responseMimeType: "application/json" 
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    // レート制限 (429) 対応
    if (response.status === 429) {
      if (retryCount < 10) { 
        // 指数バックオフ + ランダムゆらぎ
        const baseWait = Math.pow(1.5, retryCount + 1) * 1000;
        const jitter = Math.random() * 2000;
        const waitTime = Math.min(baseWait + jitter, 30000); // 最大30秒待機

        console.warn(`API制限検知。${Math.round(waitTime)}ms 待機後にリトライします (${retryCount + 1}/10)`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return checkIPRiskBulk(products, apiKey, retryCount + 1);
      } else { 
        throw new Error("API混雑により判定できませんでした"); 
      }
    }
    
    if (!response.ok) throw new Error(`API Error: ${response.status}`);
    
    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error("No response");
    
    // JSONクリーニングとパース
    const cleanText = cleanJson(rawText);
    let parsedResults;
    try {
      parsedResults = JSON.parse(cleanText);
      if (!Array.isArray(parsedResults)) throw new Error("レスポンスが配列ではありません");
    } catch (e) {
      console.error("JSON Parse Error:", e, cleanText);
      throw new Error("AIレスポンスの解析に失敗しました");
    }

    const resultMap = {};
    parsedResults.forEach(item => {
      let risk = item.risk_level;
      // 表記ゆれ吸収
      if (risk === '危険') risk = 'Critical';
      if (risk === '高') risk = 'High';
      if (risk === '中') risk = 'Medium';
      if (risk === '低') risk = 'Low';
      if (!risk) risk = 'Medium'; // デフォルトはMedium（安全側）
      
      resultMap[item.id] = { risk, reason: item.reason };
    });
    
    return resultMap;

  } catch (error) {
    console.error("Bulk Check Error:", error);
    // 致命的なエラーでもリトライ回数が残っていればリトライ
    if (retryCount < 3 && !error.message.includes("429")) {
        const waitTime = 2000 + Math.random() * 2000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return checkIPRiskBulk(products, apiKey, retryCount + 1);
    }
    
    // どうしてもダメな場合は、全件エラーとして返す（処理を止めないため）
    const errorMap = {};
    products.forEach(p => {
      errorMap[p.id] = { risk: "Error", reason: `判定エラー: ${error.message}` };
    });
    return errorMap;
  }
}

/**
 * 2. 二次審査: 個別の商品を深掘り判定する詳細処理
 */
async function checkIPRiskDetail(product, apiKey, retryCount = 0) {
  const systemInstruction = `
あなたは知的財産権・薬機法・景品表示法に精通した【専門の弁護士】です。
一次審査の検閲官が「リスクあり」と判定した以下の商品について、セカンドオピニオン（詳細鑑定）を提供してください。

【商品情報】
商品名: ${product.productName}
一次判定: ${product.risk}
一次理由: ${product.reason}

【依頼内容】
1. 一次判定が妥当かどうか、法的な観点（商標法、不正競争防止法、薬機法、景表法など）から厳密に検証してください。
2. もし一次判定が「過剰反応（実は安全）」である場合は、理由を明確に添えて判定を「Low」に修正してください。
3. リスクがある場合は、「なぜ違法性があるのか」「どの言葉がアウトなのか」を担当者が納得できるよう具体的に解説してください。

【出力形式】
JSONのみを出力してください。
{
  "final_risk": "Critical/High/Medium/Low",
  "detailed_analysis": "専門家としての詳細な見解（200文字程度で具体的に）"
}
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`;
  
  const payload = {
    contents: [{ parts: [{ text: `この商品のリスクを詳細に鑑定せよ。` }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: { responseMimeType: "application/json" }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (response.status === 429) {
      if (retryCount < 10) { 
        const waitTime = Math.pow(1.5, retryCount + 1) * 2000 + Math.random() * 2000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return checkIPRiskDetail(product, apiKey, retryCount + 1);
      } else { throw new Error("API混雑"); }
    }
    
    if (!response.ok) throw new Error(`API Error: ${response.status}`);
    
    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    const cleanText = cleanJson(rawText);
    const result = JSON.parse(cleanText);
    
    let risk = result.final_risk;
    if (risk === '危険') risk = 'Critical';
    if (risk === '高') risk = 'High';
    if (risk === '中') risk = 'Medium';
    if (risk === '低') risk = 'Low';

    return { risk, detail: result.detailed_analysis };

  } catch (error) {
    return { risk: product.risk, detail: `詳細分析失敗: ${error.message}` };
  }
}

// ==========================================
// 3. メインコンポーネント
// ==========================================
export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [inputPassword, setInputPassword] = useState('');
  
  const [apiKey, setApiKey] = useState('');
  const [firebaseConfigJson, setFirebaseConfigJson] = useState('');
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
  const [encoding, setEncoding] = useState('Shift_JIS');
  
  // デフォルトで高速モードON
  const [isHighSpeed, setIsHighSpeed] = useState(true); 
  
  const stopRef = useRef(false);

  useEffect(() => {
    const savedKey = localStorage.getItem('gemini_api_key');
    const savedFbConfig = localStorage.getItem('firebase_config');
    if (savedKey) setApiKey(savedKey);
    if (savedFbConfig) {
      setFirebaseConfigJson(savedFbConfig);
      initFirebase(savedFbConfig);
    }
  }, []);

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
    localStorage.setItem('gemini_api_key', apiKey);
    localStorage.setItem('firebase_config', firebaseConfigJson);
    if (firebaseConfigJson) initFirebase(firebaseConfigJson);
    alert("設定を保存しました");
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
            const nameIndex = fileHeaders.findIndex(h => 
              h.includes('商品名') || h.includes('Name') || h.includes('Product') || h.includes('名称')
            );
            setTargetColIndex(nameIndex !== -1 ? nameIndex : 0);
          }
          
          const rowsWithFileName = fileRows.map(row => [...row, file.name]); 
          newRows = [...newRows, ...rowsWithFileName];
        }
      } catch (err) { 
        alert(`${file.name} の読み込みに失敗しました。エンコードを確認してください。`); 
      }
    }
    setCsvData(prev => [...prev, ...newRows]);
  };

  // --- 一次審査（バルク） ---
  const startProcessing = async () => {
    if (!apiKey) return alert("設定画面でAPIキーを入力してください");
    if (csvData.length === 0) return;

    setIsProcessing(true);
    setIsDetailAnalyzing(false);
    stopRef.current = false;
    setResults([]); 

    // === 鬼バルクモード設定（最適化済み） ===
    // BULK_SIZE: 30件 (Gemini 2.0なら余裕で、かつ速度が出る)
    const BULK_SIZE = 30; 
    // CONCURRENCY: 3並列 (多すぎると429エラーで逆に遅くなるため、3が黄金比)
    const CONCURRENCY = isHighSpeed ? 3 : 2;

    let currentIndex = 0;
    const total = csvData.length;

    // 初動の分散（多重タブ対策）
    const initialJitter = Math.random() * 2000;
    await new Promise(resolve => setTimeout(resolve, initialJitter));

    while (currentIndex < total) {
      if (stopRef.current) break;

      const tasks = [];
      
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
          // エラーが発生してもcatch内で処理され、必ず結果が返ってくるように設計
          tasks.push(
            checkIPRiskBulk(chunkProducts, apiKey).then(resultMap => {
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
        // 並列処理の完了を待つ
        const chunkResults = await Promise.all(tasks);
        const flatResults = chunkResults.flat();
        
        // 結果を画面に追加
        setResults(prev => [...prev, ...flatResults]);
        
        // 進捗を更新
        const processedCount = flatResults.length;
        currentIndex += processedCount; // 実際に処理した数だけ進める
        
        const nextProgress = Math.round((currentIndex / total) * 100);
        setProgress(nextProgress);
      }

      // 次のバッチへのインターバル（API制限回避）
      const baseWait = isHighSpeed ? 300 : 1500;
      const jitter = Math.random() * 500;
      if (currentIndex < total) {
        await new Promise(resolve => setTimeout(resolve, baseWait + jitter));
      }
    }
    
    setProgress(100);
    setIsProcessing(false);
  };

  // --- 二次審査（詳細分析） ---
  const startDetailAnalysis = async () => {
    if (!apiKey) return;
    setIsDetailAnalyzing(true);
    stopRef.current = false;

    const riskyItems = results.filter(r => ['Critical', 'High', 'Medium'].includes(r.risk));
    const totalRisky = riskyItems.length;
    
    let newResults = [...results];
    
    const CONCURRENCY = 5;
    
    await new Promise(resolve => setTimeout(resolve, Math.random() * 2000));

    for (let i = 0; i < totalRisky; i += CONCURRENCY) {
      if (stopRef.current) break;
      
      const batch = riskyItems.slice(i, i + CONCURRENCY);
      const promises = batch.map(item => checkIPRiskDetail(item, apiKey).then(res => ({
        id: item.id,
        finalRisk: res.risk,
        detail: res.detail
      })));

      const batchResults = await Promise.all(promises);

      batchResults.forEach(res => {
        const index = newResults.findIndex(r => r.id === res.id);
        if (index !== -1) {
          newResults[index] = {
            ...newResults[index],
            risk: res.finalRisk, 
            detailedReason: res.detail,
            isDetailed: true
          };
          saveToHistory(newResults[index]);
        }
      });
      
      setResults([...newResults]); 
      
      await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));
    }

    setIsDetailAnalyzing(false);
  };

  const downloadCSV = (dataToDownload, filterRisky = false) => {
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    let csvContent = "商品名,リスク判定,理由,詳細分析(AI弁護士),元ファイル名,判定日時\n";
    
    const data = filterRisky 
      ? dataToDownload.filter(r => r.risk !== 'Low' && r.risk !== 'Error') 
      : dataToDownload;

    if (data.length === 0) {
      return alert("該当するデータがありません");
    }

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
    const prefix = filterRisky ? "risky_detailed" : "all";
    link.setAttribute("download", `ip_check_${prefix}_${new Date().getTime()}.csv`);
    document.body.appendChild(link);
    link.click(); 
    document.body.removeChild(link);
  };

  const RiskBadge = ({ risk }) => {
    const config = RISK_MAP[risk] || RISK_MAP['Error'];
    return (
      <span className={`px-3 py-1 rounded-full text-xs font-bold border whitespace-nowrap ${config.color}`}>
        {risk === 'Critical' && <Siren className="w-3 h-3 inline mr-1 mb-0.5" />}
        {config.label}
      </span>
    );
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <div className="bg-white p-16 rounded-2xl shadow-2xl w-full max-w-5xl transition-all border border-slate-200">
          <div className="flex flex-col items-center">
            <div className="bg-blue-50 p-6 rounded-full mb-8">
              <Lock className="w-16 h-16 text-blue-600" />
            </div>
            <h1 className="text-4xl font-extrabold text-center text-slate-800 mb-3 tracking-tight">IP Patrol Pro</h1>
            <span className="text-sm font-bold bg-indigo-100 text-indigo-700 px-4 py-1.5 rounded-full mb-10">鬼バルクモード搭載</span>
          </div>
          
          <form onSubmit={handleLogin} className="space-y-8 max-w-xl mx-auto"> 
            <div>
              <label className="block text-sm font-bold text-slate-600 mb-2">パスワード</label>
              <input 
                type="password" 
                value={inputPassword} 
                onChange={(e) => setInputPassword(e.target.value)}
                className="w-full px-6 py-4 border border-slate-300 rounded-xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 outline-none transition-all text-lg"
                placeholder="パスワードを入力"
                autoFocus
              />
            </div>
            <button type="submit" className="w-full bg-blue-600 text-white py-4 rounded-xl font-bold text-xl hover:bg-blue-700 shadow-xl shadow-blue-200 transition-all active:scale-95">
              ログインして開始
            </button>
          </form>
          
          <p className="text-center text-xs text-slate-400 mt-12 font-mono">
            Authorized Personnel Only
          </p>
        </div>
      </div>
    );
  }

  // 危険なアイテムの数
  const riskyCount = results.filter(r => ['Critical', 'High', 'Medium'].includes(r.risk)).length;
  const analyzedCount = results.filter(r => r.isDetailed).length;

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
              <button 
                key={tab}
                onClick={() => setActiveTab(tab)} 
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === tab ? 'bg-blue-50 text-blue-600' : 'text-slate-500 hover:bg-slate-50'}`}
              >
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
              <div className="flex flex-col lg:flex-row gap-6">
                <div className="flex-1">
                  <div className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center hover:bg-blue-50 transition-colors relative cursor-pointer min-h-[160px] flex flex-col items-center justify-center group">
                    <input 
                      type="file" 
                      accept=".csv" 
                      multiple 
                      onChange={handleFileUpload} 
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" 
                    />
                    <FolderOpen className="w-10 h-10 text-slate-400 mb-3 group-hover:text-blue-500 transition-colors" />
                    <p className="text-base font-bold text-slate-700">CSVファイルをここにドロップ（複数可）</p>
                    <p className="text-xs text-slate-500 mt-1">またはクリックしてファイルを選択</p>
                  </div>
                  
                  {files.length > 0 && (
                    <div className="mt-4 bg-slate-50 rounded-lg p-3 border border-slate-100">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-xs font-bold text-slate-600">読み込み済みファイル ({files.length})</span>
                        <button onClick={() => {setFiles([]); setCsvData([]); setResults([]);}} className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1"><Trash2 className="w-3 h-3" /> 全削除</button>
                      </div>
                      <div className="max-h-24 overflow-y-auto space-y-1">
                        {files.map((f, i) => (
                          <div key={i} className="text-xs text-slate-500 flex items-center gap-2">
                            <FileText className="w-3 h-3" /> {f.name}
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 pt-2 border-t border-slate-200 text-right">
                        <span className="text-sm font-bold text-blue-700">合計 {csvData.length} 件</span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="w-full lg:w-80 space-y-4">
                  <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
                    <h3 className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-2"><Settings className="w-4 h-4" /> 読込オプション</h3>
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">文字コード</label>
                        <select value={encoding} onChange={(e) => setEncoding(e.target.value)} className="w-full px-3 py-2 border rounded bg-white text-sm">
                          <option value="Shift_JIS">Shift_JIS (楽天/Excel)</option>
                          <option value="UTF-8">UTF-8 (一般/Web)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">チェック対象カラム</label>
                        <select value={targetColIndex} onChange={(e) => setTargetColIndex(Number(e.target.value))} className="w-full px-3 py-2 border rounded bg-white text-sm" disabled={headers.length === 0}>
                          {headers.length === 0 && <option>ファイルを読み込んでください</option>}
                          {headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                        </select>
                      </div>
                    </div>
                  </div>

                  <div 
                    onClick={() => setIsHighSpeed(!isHighSpeed)}
                    className={`p-4 rounded-lg border cursor-pointer transition-all ${isHighSpeed ? 'bg-indigo-50 border-indigo-200 ring-2 ring-indigo-100' : 'bg-white border-slate-200'}`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Layers className={`w-5 h-5 ${isHighSpeed ? 'text-indigo-600 fill-indigo-600' : 'text-slate-400'}`} />
                        <span className={`font-bold text-sm ${isHighSpeed ? 'text-indigo-900' : 'text-slate-600'}`}>鬼バルクモード</span>
                      </div>
                      <div className={`w-10 h-5 rounded-full relative transition-colors ${isHighSpeed ? 'bg-indigo-600' : 'bg-slate-300'}`}>
                        <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-transform ${isHighSpeed ? 'left-6' : 'left-1'}`} />
                      </div>
                    </div>
                    <p className="text-xs text-slate-500">
                      見逃し厳禁・鬼検閲官による一括判定。疑わしいものは全て警告します。
                    </p>
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-slate-100">
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                      <span>一次審査進捗</span>
                      <span>{progress}% ({results.length} / {csvData.length})</span>
                    </div>
                    <div className="bg-slate-100 rounded-full h-3 overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-blue-500 to-indigo-600 transition-all duration-300" style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                  
                  {!isProcessing && !isDetailAnalyzing ? (
                    <button 
                      onClick={startProcessing} 
                      disabled={files.length === 0} 
                      className="flex items-center gap-2 px-8 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white font-bold rounded-lg shadow-md transition-transform active:scale-95"
                    >
                      <Play className="w-5 h-5" /> 一次審査開始
                    </button>
                  ) : (
                    <button 
                      onClick={() => {stopRef.current = true; setIsProcessing(false); setIsDetailAnalyzing(false);}} 
                      className="flex items-center gap-2 px-8 py-3 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg shadow-md transition-transform active:scale-95"
                    >
                      <Pause className="w-5 h-5" /> 一時停止
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* ダブルチェック（詳細分析）アクションエリア */}
            {riskyCount > 0 && !isProcessing && (
              <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-6 flex flex-col md:flex-row items-center justify-between gap-4 animate-in slide-in-from-top-2">
                <div className="flex items-start gap-3">
                  <div className="bg-indigo-100 p-2 rounded-lg text-indigo-600">
                    <Scale className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="font-bold text-indigo-900">AI弁護士によるダブルチェック</h3>
                    <p className="text-sm text-indigo-700 mt-1">
                      一次審査で「リスクあり」とされた <span className="font-bold text-indigo-900 bg-indigo-200 px-2 rounded">{riskyCount}件</span> の商品に対し、専門家AIが1件ずつ詳細な法的根拠を鑑定します。
                    </p>
                    {isDetailAnalyzing && (
                       <p className="text-xs font-mono text-indigo-500 mt-2">詳細分析中... {analyzedCount} / {riskyCount} 完了</p>
                    )}
                  </div>
                </div>
                {!isDetailAnalyzing ? (
                  <button 
                    onClick={startDetailAnalysis}
                    className="flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-lg shadow-lg shadow-indigo-200 transition-all active:scale-95 whitespace-nowrap"
                  >
                    <SearchCheck className="w-5 h-5" /> 詳細鑑定を実行
                  </button>
                ) : (
                   <div className="flex items-center gap-2 text-indigo-600 font-bold px-4">
                     <Loader2 className="w-5 h-5 animate-spin" /> 鑑定中...
                   </div>
                )}
              </div>
            )}

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col h-[600px]">
              <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50 shrink-0">
                <div className="flex items-center gap-3">
                  <h2 className="font-bold text-slate-700 flex items-center gap-2"><CheckCircle className="w-5 h-5 text-green-600" /> 判定結果</h2>
                  <span className="bg-slate-200 text-slate-600 px-2 py-0.5 rounded text-xs font-mono">{results.length} 件</span>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => downloadCSV(results, true)} 
                    disabled={results.length === 0} 
                    className="px-4 py-2 bg-red-50 border border-red-200 hover:bg-red-100 text-red-700 rounded-lg text-sm font-medium flex items-center gap-2 shadow-sm disabled:opacity-50 transition-colors"
                  >
                    <Download className="w-4 h-4" /> リスクありのみ保存
                  </button>
                  <button 
                    onClick={() => downloadCSV(results, false)} 
                    disabled={results.length === 0} 
                    className="px-4 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg text-sm font-medium flex items-center gap-2 shadow-sm disabled:opacity-50"
                  >
                    <Download className="w-4 h-4" /> 全件保存
                  </button>
                </div>
              </div>
              
              <div className="flex-1 overflow-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-slate-500 uppercase bg-slate-50 sticky top-0 z-10 shadow-sm">
                    <tr>
                      <th className="px-4 py-3 w-28 text-center">判定</th>
                      <th className="px-4 py-3 w-1/3">商品名</th>
                      <th className="px-4 py-3">
                        指摘理由・リスク要因
                        <span className="block text-[10px] text-slate-400 font-normal">上段:一次審査 / 下段:詳細鑑定</span>
                      </th>
                      <th className="px-4 py-3 w-32">元ファイル</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {results.map((item, idx) => (
                      <tr key={idx} className={`hover:bg-slate-50 transition-colors ${item.risk === 'Critical' ? 'bg-rose-50' : ''}`}>
                        <td className="px-4 py-3 text-center">
                          <RiskBadge risk={item.risk} />
                          {item.isDetailed && <div className="mt-1 text-[10px] text-indigo-600 font-bold border border-indigo-200 bg-indigo-50 rounded px-1">鑑定済</div>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-700 line-clamp-2" title={item.productName}>
                            {item.productName}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className={`text-xs mb-1 ${item.risk === 'Critical' ? 'text-rose-700 font-bold' : item.risk === 'High' ? 'text-red-600 font-bold' : 'text-slate-600'}`}>
                            {item.reason}
                          </div>
                          {item.detailedReason && (
                            <div className="text-xs text-indigo-700 bg-indigo-50 p-2 rounded border border-indigo-100 mt-1">
                              <span className="font-bold mr-1">【弁護士AI】</span>
                              {item.detailedReason}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-400 truncate max-w-[150px]" title={item.sourceFile}>
                          {item.sourceFile}
                        </td>
                      </tr>
                    ))}
                    {results.length === 0 && (
                      <tr>
                        <td colSpan="4" className="px-4 py-12 text-center text-slate-400">
                          データがありません。CSVをアップロードしてチェックを開始してください。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
               <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 text-xs text-blue-800 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold mb-1">健康食品・美容商材チェック</p>
                  <p>「効果効能の断定」「身体的変化の保証」「最大級表現」など、薬機法・景表法抵触の恐れがある表現をチェックします。</p>
                </div>
              </div>
              <div className="bg-rose-50 border border-rose-100 rounded-lg p-4 text-xs text-rose-800 flex items-start gap-2">
                <Siren className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold mb-1">危険・モラルチェック</p>
                  <p>おもちゃの銃（武器類似）、公序良俗に反する商品、アダルト関連など、モラルや安全性に関わる商品を「危険」として検知します。</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ... (history, settings tabs are the same) ... */}
        {activeTab === 'history' && (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden animate-in fade-in">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <div>
                <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2"><History className="w-5 h-5 text-blue-600" /> チェック履歴 (最新50件)</h2>
                <p className="text-xs text-slate-500 mt-1">「危険」「高」「中」の判定のみクラウドに保存されています。</p>
              </div>
              {!db && <span className="text-xs text-red-500 bg-red-50 px-2 py-1 rounded border border-red-100">※Firebase未設定</span>}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50">
                  <tr>
                    <th className="px-6 py-3">日時</th>
                    <th className="px-6 py-3 text-center">判定</th>
                    <th className="px-6 py-3">商品名</th>
                    <th className="px-6 py-3">理由 (詳細分析含む)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {historyData.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50">
                      <td className="px-6 py-4 whitespace-nowrap text-slate-400 text-xs">
                        {item.createdAt ? new Date(item.createdAt.seconds * 1000).toLocaleString() : '-'}
                      </td>
                      <td className="px-6 py-4 text-center"><RiskBadge risk={item.risk} /></td>
                      <td className="px-6 py-4 font-medium text-slate-700 max-w-xs truncate">{item.productName}</td>
                      <td className="px-6 py-4 text-slate-600 text-xs">{item.reason}</td>
                    </tr>
                  ))}
                  {historyData.length === 0 && (
                    <tr>
                      <td colSpan="4" className="px-6 py-8 text-center text-slate-400">履歴がありません</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in">
            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
              <h2 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2"><Settings className="w-5 h-5" /> アプリ設定</h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Gemini API Key</label>
                  <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="w-full px-4 py-2 border rounded-lg bg-slate-50" placeholder="AIza..." />
                  <p className="text-xs text-slate-500 mt-1">Google AI Studioで取得したAPIキーを入力してください。</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Firebase Config (JSON)</label>
                  <textarea 
                    value={firebaseConfigJson} 
                    onChange={(e) => setFirebaseConfigJson(e.target.value)} 
                    className="w-full px-4 py-2 border rounded-lg bg-slate-50 h-32 text-xs font-mono" 
                    placeholder='{"apiKey": "...", "authDomain": "...", "projectId": "..."}' 
                  />
                  <p className="text-xs text-slate-500 mt-1">履歴を保存するにはFirebaseの構成オブジェクト（JSON）を貼り付けてください。</p>
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