// ================核心逻辑=================
// const { playAudio, getAudioList } = TavernHelper;

const {
    chat,
    eventSource,
    event_types,
    getWorldInfoPrompt,
    extensionSettings,
    registerSlashCommand,
    saveSettingsDebounced,
} = SillyTavern.getContext();

const extensionName = "CG-Mode";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const defaultSettings = {
    extensionEnable: true,
    localMode: false,
    recentMessageCountToScan: 2,
    ASSET_SERVER_URL: "",
    cgFolder: "",
    bgFolder: "",
    cgFolder_Mobile: "",
    bgFolder_Mobile: "",
};

if (!extensionSettings[extensionName]) {
    extensionSettings[extensionName] = {};
}

Object.assign(extensionSettings[extensionName], {
    ...defaultSettings,
    ...extensionSettings[extensionName],
});

//同步设置到面板UI
function loadSettings() {
    if (Object.keys(extensionSettings[extensionName]).length === 0)
        Object.assign(extensionSettings[extensionName], defaultSettings);
    $("#CG_Mode_enable")
        .prop("checked", extensionSettings[extensionName].extensionEnable)
        .trigger("input");
    $("#CG_Mode_local")
        .prop("checked", extensionSettings[extensionName].localMode)
        .trigger("input");
    $("#CG_server_url")
        .val(extensionSettings[extensionName].ASSET_SERVER_URL)
        .trigger("input");
    $("#CG_recent_message_count_to_scan")
        .val(extensionSettings[extensionName].recentMessageCountToScan)
        .trigger("input");
    $("#CG_bgFolder")
        .val(extensionSettings[extensionName].bgFolder)
        .trigger("input");
    $("#CG_cgFolder")
        .val(extensionSettings[extensionName].cgFolder)
        .trigger("input");
    $("#CG_bgFolder_mobile")
        .val(extensionSettings[extensionName].bgFolder_Mobile)
        .trigger("input");
    $("#CG_cgFolder_mobile")
        .val(extensionSettings[extensionName].cgFolder_Mobile)
        .trigger("input");
}

function updateSettings(event) {
    const target = $(event.target);
    let value;
    if (target.is(":checkbox")) value = Boolean(target.prop("checked"));
    else value = target.val();
    const settingKey = target.data("setting-key");
    extensionSettings[extensionName][settingKey] = value;
    saveSettingsDebounced();
}

jQuery(async () => {
    const settingsHtml = await $.get(`${extensionFolderPath}/setting.html`);
    $("#extensions_settings").append(settingsHtml);
    $("#extensions_settings").on("input", ".CG_setting_input", updateSettings);
    $("#extensions_settings").on("click", "#CG_check_connection", () => {
        const url = $("#CG_server_url").val();
        if (url) checkLink(url);
        else toastr.info("请先输入服务器地址");
    });
    loadSettings();
});

const getSettings = () => extensionSettings[extensionName];
const isMobile = SillyTavern.getContext().isMobile();
const SUPPORTED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]; //支持的图片扩展名
const maxContext = 99999; //确保能扫描到所有世界书
const isDryRun = true; //干运行，不发送事件
const cgRegex = /\[(CG|BG):(.+?)]/;
const bgmRegex = /\[BGM:(.+?)]/;
const ambRegex = /\[AMB:(.+?)]/;
let isScanning = false;
let lastImg = "";
let lastBgm = "";
let lastAmb = "";
let bgmAudio;
let ambAudio;

//检查图片文件是否存在
async function findValidImageUrl(filename, isCG) {
    const cleanFilename = filename.trim();
    const settings = getSettings();
    let folder;
    if (isCG) folder = isMobile ? settings.cgFolder_Mobile : settings.cgFolder;
    else folder = isMobile ? settings.bgFolder_Mobile : settings.bgFolder;
    const rootPath = folder
        ? `${settings.ASSET_SERVER_URL}/${folder}/${cleanFilename}`
        : `${settings.ASSET_SERVER_URL}/${cleanFilename}`; //没有填则在根目录寻找
    for (const ext of SUPPORTED_EXTENSIONS) {
        const url = rootPath + ext;
        try {
            const response = await fetch(url, { method: "HEAD" });
            if (response.ok) return url;
        } catch (error) {
            // 忽略网络错误，继续尝试下一个后缀
        }
    }
    toastr.warning(`[CG模式] ${folder}中找不到图片：${filename}`);
    return null;
}

/**
 * 预加载图片并返回一个 Promise
 * @param {string} url - 图片的完整 URL
 * @returns {Promise<string>} - 加载成功后返回原 URL
 */
function preloadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            resolve(url);
        };
        img.onerror = () => {
            reject(new Error(`[CG模式] 图片加载失败或文件不存在: ${url}`));
        };
        img.src = url;
    });
}

//核心函数逻辑
async function scanWorldInfo() {
    const settings = getSettings();
    if (!settings.extensionEnable || isScanning || chat.length === 0) return;
    isScanning = true;
    const reverseChat = chat
        .slice(-Number(settings.recentMessageCountToScan))
        .reverse();
    const mesHistory = reverseChat.map((c) => c.mes);
    let result;
    try {
        // @ts-ignore
        result = await getWorldInfoPrompt(mesHistory, maxContext, isDryRun);
    } catch (e) {
        return console.error("[CG模式] Failed to get World Info:", e);
    }
    const worldInfoString = result.worldInfoString;
    if (!worldInfoString) return;
    const cgMatch = worldInfoString.match(cgRegex);
    const bgmMatch = worldInfoString.match(bgmRegex);
    const ambMatch = worldInfoString.match(ambRegex);
    if (cgMatch) eventSource.emit("update_cg", cgMatch);
    else console.log("[CG模式] 世界书中未扫描到CG/BG标签");
    if (bgmMatch) eventSource.emit("update_bgm", bgmMatch);
    else console.log("[CG模式] 世界书中未扫描到BGM标签");
    if (ambMatch) eventSource.emit("update_amb", ambMatch);
    else console.log("[CG模式] 世界书中未扫描到AMB标签");
    isScanning = false;
}

eventSource.on("update_cg", async (cgMatch) => {
    if (cgMatch[0] !== lastImg) {
        if (getSettings()["localMode"]) {
            $(`.BGSampleTitle:contains(${cgMatch[2]})`).trigger("click");
        } else {
            const isCG = cgMatch[1] === "CG";
            const url = await findValidImageUrl(cgMatch[2], isCG);
            if (url) {
                try {
                    await preloadImage(url);
                    applyBackgroundImage(url, isCG);
                    lastImg = cgMatch[0];
                } catch (error) {
                    toastr.error(error.message);
                }
            }
        }
    } else console.log("[CG模式] 与上次图片相同，无需更新CG");
});

eventSource.on("update_bgm", async (bgmMatch) => {
    if (bgmMatch[0] !== lastBgm) {
        const bgmName = bgmMatch[1];
        const bgmList = TavernHelper.getAudioList("bgm");
        const index = bgmList.findIndex((bgm) => bgm.title === bgmName);
        if (index !== -1) {
            bgmAudio =
                bgmAudio ||
                $(".flex.max-w-full.flex-col.gap-1").find("audio")[0];
            if (!bgmAudio.paused) await audioFadeOut(bgmAudio, 1500);
            setTimeout(() => {
                TavernHelper.playAudio("bgm", bgmList[index]);
            }, 500);
            lastBgm = bgmMatch[0];
        } else console.log(`[CG模式] 播放列表不存在BGM：${bgmName}`);
    } else console.log("[CG模式] 与上次BGM相同，无需更新");
});

eventSource.on("update_amb", async (ambMatch) => {
    if (ambMatch[0] !== lastAmb) {
        const ambName = ambMatch[1];
        const ambList = TavernHelper.getAudioList("ambient");
        const index = ambList.findIndex((amb) => amb.title === ambName);
        if (index !== -1) {
            ambAudio =
                ambAudio ||
                $(".flex.max-w-full.flex-col.gap-1").find("audio")[1];
            if (!ambAudio.paused) await audioFadeOut(ambAudio, 1000);
            setTimeout(() => {
                TavernHelper.playAudio("ambient", ambList[index]);
            }, 500);
            lastAmb = ambMatch[0];
        } else console.log(`[CG模式] 播放列表不存在环境音：${ambName}`);
    } else console.log("[CG模式] 与上次AMB相同，无需更新");
});

//音频淡出函数
function audioFadeOut(audio, duration) {
    return new Promise((resolve) => {
        const interval = 50;
        const initialVolume = audio.volume;
        const steps = duration / interval;
        const volumeStep = initialVolume / steps;
        let currentStep = 1;
        const fadeInterval = setInterval(() => {
            currentStep++;
            audio.volume = Math.max(
                0,
                initialVolume - volumeStep * currentStep
            );
            if (currentStep >= steps || audio.volume <= 0) {
                audio.pause();
                clearInterval(fadeInterval);
                audio.volume = initialVolume;
                resolve();
            }
        }, interval);
    });
}

/**
 * 辅助函数：应用背景图并控制立绘显示
 * @param {string} url - 图片地址
 */
function applyBackgroundImage(url, isCG) {
    if (!url) return;
    const bgElement = $("#bg1");
    bgElement.css({
        "background-image": `url("${url}")`,
        "background-size": "cover", // 强制背景覆盖
        "background-position": "center", // 强制居中
    });
    const sprites = $("#expression-holder");
    if (isCG) {
        sprites.hide();
    } else {
        if (sprites.is(":hidden")) {
            sprites.fadeIn(200); //BG模式平滑淡入
        } else {
            sprites.show();
        }
        console.log(`[CG模式] Background updated to: ${url} (isCG: ${isCG})`);
    }
}
//开始监听
eventSource.on(event_types.MESSAGE_SENT, scanWorldInfo);
eventSource.on(event_types.MESSAGE_RECEIVED, scanWorldInfo);
eventSource.on(event_types.CHAT_CHANGED, scanWorldInfo);

// 注册斜杠命令
async function setcg(_, cgName) {
    const nameStr = String(cgName || "").trim();
    if (!nameStr) {
        toastr.info("请输入图片名称");
        return;
    }
    const tag = `[CG:${nameStr}]`;
    if (tag === lastImg) return;
    const url = await findValidImageUrl(nameStr, true);
    if (url) {
        try {
            await preloadImage(url);
            applyBackgroundImage(url, true);
            lastImg = tag;
        } catch (error) {
            toastr.error(error.message);
        }
    }
    return "";
}
async function setbg(_, bgName) {
    const nameStr = String(bgName || "").trim();
    if (!nameStr) {
        toastr.info("请输入图片名称");
        return;
    }
    const tag = `[BG:${nameStr}]`;
    if (tag === lastImg) return;
    const url = await findValidImageUrl(nameStr, false);
    if (url) {
        try {
            await preloadImage(url);
            applyBackgroundImage(url, false);
            lastImg = tag;
        } catch (error) {
            toastr.error(error.message);
        }
    }
    return "";
}
registerSlashCommand("setcg", setcg, ["cg"]);
registerSlashCommand("setbg", setbg, []);

//检查服务器连接
async function checkLink(url) {
    try {
        const response = await fetch(url, {
            method: "GET",
        });
        if (!response.ok) {
            throw new Error(response.statusText);
        }
        toastr.success(`[CG模式] ${url} 连接成功。`);
    } catch (error) {
        toastr.error(error, `[CG模式] ${url} 连接失败。`);
    }
}
console.log("CG Mode Extension Loaded.");
