#!/usr/bin/env node
"use strict";
/*
 * AllKnowing: a recording turned into text on this Mac, by free speech models that check each other.
 *
 * Nothing here calls a paid service and no audio leaves the computer. The hub (hub.cjs) downloads the
 * engine and the models once (see ENGINE and MODELS below), then runs this file for each recording:
 *
 *   node speech.cjs run <job folder> <speech folder>     the whole job, reporting progress as it goes
 *   node speech.cjs step <name> <job folder> <speech folder>   one step (run uses this)
 *   node speech.cjs check <speech folder>                 is everything here and working, and how fast
 *
 * A job folder holds sound.wav (16 kHz, one channel, 16-bit) and ask.json; result.json comes out.
 *
 * How a recording is heard:
 *   1. first    The speech is found (Silero VAD) and every stretch of it is heard by SenseVoice, which
 *               also says which language it is.
 *   2. second   Stretches are joined into pieces of up to 16 seconds in one language, and a second
 *               model hears each piece: Parakeet for English and European languages, Paraformer for
 *               Chinese.
 *   3. judge    Where the two don't agree word for word, a third and stronger model, Qwen3-ASR,
 *               hears the piece too (with the meeting's names and terms as hints).
 *   4. voices   The voices are told apart (pyannote segmentation and CAM++ voiceprints).
 *   5. settle   For every piece the three texts are lined up word by word. Two that agree outvote
 *               the third; where all three differ the most trusted one is kept and the other readings
 *               are noted, so that Claude and the reader know which words are in doubt.
 *
 * Each step runs in its own process, so a model's memory is given back before the next one loads,
 * and saves as it goes, so a job carries on after a restart.
 *
 * The engine is sherpa-onnx (Apache-2.0) with ONNX Runtime (MIT). The models: SenseVoice and
 * Paraformer (FunASR model licence), Parakeet TDT 0.6b v3 (CC-BY-4.0), Qwen3-ASR 0.6B (Apache-2.0),
 * Silero VAD (MIT), pyannote segmentation 3.0 (MIT), 3D-Speaker CAM++ (Apache-2.0). The Traditional
 * to Simplified table below is from OpenCC (Apache-2.0).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

/* ---------- what gets downloaded, once ---------- */
const GH = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const NPM = "https://registry.npmjs.org";
const ENGINE_VERSION = "2.0.1";
// The engine is the sherpa-onnx-node package and the build of it for this kind of computer.
const ENGINE = {
	node: {
		url: `${NPM}/sherpa-onnx-node/-/sherpa-onnx-node-${ENGINE_VERSION}.tgz`,
		sha256: "06ef8dfb9ea0f3cc77c1866620cbe05bf11b7dd70a973a454b77ce4a66cbcee1",
		bytes: 12709,
		into: "sherpa-onnx-node",
	},
	"darwin-x64": {
		url: `${NPM}/sherpa-onnx-darwin-x64/-/sherpa-onnx-darwin-x64-${ENGINE_VERSION}.tgz`,
		sha256: "e95e4addd3d02919ae61f311effd6e5349e00b50985c4a8c9a3bcb03dc6d6325",
		bytes: 11167483,
		into: "sherpa-onnx-darwin-x64",
	},
	"darwin-arm64": {
		url: `${NPM}/sherpa-onnx-darwin-arm64/-/sherpa-onnx-darwin-arm64-${ENGINE_VERSION}.tgz`,
		sha256: "afc9415260e232c4dadc25a29a8645acb0ba06ef989060d32274f4c749a4830e",
		bytes: 10013200,
		into: "sherpa-onnx-darwin-arm64",
	},
	"linux-x64": {
		url: `${NPM}/sherpa-onnx-linux-x64/-/sherpa-onnx-linux-x64-${ENGINE_VERSION}.tgz`,
		sha256: "08c6fe2b65838febbd0c260aaa9991990d2d592e503e758bfd2f5db6cbc79338",
		bytes: 11005484,
		into: "sherpa-onnx-linux-x64",
	},
	"linux-arm64": {
		url: `${NPM}/sherpa-onnx-linux-arm64/-/sherpa-onnx-linux-arm64-${ENGINE_VERSION}.tgz`,
		sha256: "b8f18ee34c8e14bbafb7f51332361a6ab91f4ddbb4a4eac58f74ec0dafb39e87",
		bytes: 13822449,
		into: "sherpa-onnx-linux-arm64",
	},
};
// `dir` is the folder a .tar.bz2 unpacks to; `file` is a download used as it is.
const MODELS = {
	vad: {
		name: "Silero VAD",
		does: "finds the speech",
		url: `${GH}/asr-models/silero_vad.onnx`,
		sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
		bytes: 643854,
		file: "silero_vad.onnx",
	},
	first: {
		name: "SenseVoice",
		does: "hears everything, in Chinese, Cantonese, English, Japanese or Korean",
		url: `${GH}/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`,
		sha256: "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e",
		bytes: 163002883,
		dir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
		has: ["model.int8.onnx", "tokens.txt", "test_wavs/en.wav", "test_wavs/zh.wav"],
	},
	latin: {
		name: "Parakeet",
		does: "hears English and European languages a second time",
		url: `${GH}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
		sha256: "1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9",
		bytes: 487211443,
		dir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
		has: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
	},
	cjk: {
		name: "Paraformer",
		does: "hears Chinese a second time",
		url: `${GH}/asr-models/sherpa-onnx-paraformer-zh-int8-2025-10-07.tar.bz2`,
		sha256: "a071ee5419e14adb34d7f970ab98105a45e6608018b168f023ca2e4810744abe",
		bytes: 228262632,
		dir: "sherpa-onnx-paraformer-zh-int8-2025-10-07",
		has: ["model.int8.onnx", "tokens.txt"],
	},
	judge: {
		name: "Qwen3-ASR",
		does: "settles what the other two disagree on",
		url: `${GH}/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2`,
		sha256: "393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96",
		bytes: 878702423,
		dir: "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
		has: ["conv_frontend.onnx", "encoder.int8.onnx", "decoder.int8.onnx", "tokenizer/vocab.json"],
	},
	turns: {
		name: "pyannote segmentation",
		does: "finds where the speaker changes",
		url: `${GH}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
		sha256: "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488",
		bytes: 6958444,
		dir: "sherpa-onnx-pyannote-segmentation-3-0",
		has: ["model.int8.onnx"],
	},
	voice: {
		name: "CAM++",
		does: "tells one voice from another",
		url: `${GH}/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`,
		sha256: "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2",
		bytes: 28281164,
		file: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
	},
};
// A check can put a small stand-in list in place of the real downloads.
if (process.env.AK_SPEECH_CATALOGUE) {
	const c = JSON.parse(fs.readFileSync(process.env.AK_SPEECH_CATALOGUE, "utf8"));
	for (const [list, given] of [
		[ENGINE, c.ENGINE],
		[MODELS, c.MODELS],
	]) {
		if (!given) continue;
		for (const k of Object.keys(list)) delete list[k];
		Object.assign(list, given);
	}
}
// Rough speeds (seconds of recording heard per second of work) until this computer has measured its own.
const SPEEDS = { first: 14, latin: 7, cjk: 14, judge: 2.2, voices: 7.5 };
const RATE = 16000;
const PIECE = Number(process.env.AK_SPEECH_PIECE_SECONDS) || 16; // the longest piece a model hears at once
const BLOCK = (Number(process.env.AK_SPEECH_BLOCK_MINUTES) || 90) * 60; // voices are told apart this much at a time

const platformKey = () => `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
const enginePath = (home) => path.join(home, "engine", "node_modules", "sherpa-onnx-node");
const modelPath = (home, key, ...more) => {
	const m = MODELS[key];
	return path.join(home, "models", m.dir || m.file, ...more);
};
function threads() {
	const asked = Number(process.env.AK_SPEECH_THREADS);
	if (asked > 0) return Math.floor(asked);
	const n = os.cpus().length || 2;
	return n <= 2 ? n : Math.min(4, Math.max(2, Math.floor(n * 0.6)));
}
// The engine is only loaded inside a step; the hub reads this file for its lists without it.
function engine(home) {
	return require(process.env.AK_SPEECH_ENGINE || enginePath(home));
}

/* ---------- comparing what the models heard ---------- */
// Traditional → Simplified, one character at a time, only so that 開 and 开 count as the same word
// when two models are compared. Built from OpenCC's tables (Apache-2.0).
// prettier-ignore
const T2S =
	"㑯㑔㑳㑇㑶㐹㓨刾㘚㘎㜄㚯㜏㛣㠏㟆㥮㤘㩜㨫㩳㧐㩵擜䁻䀥䃮鿎䊷䌶䋙䌺䋚䌻䋹䌿䋻䌾䍦䍠䎱䎬䙡䙌䜀䜧䝼䞍䥇䦂䥑鿏䥱䥾䦛䦶䦟䦷䯀䯅䰾鲃䱷䲣䱽䲝䲁鳚䲘鳤䴉鹮丟丢並并乾干亂乱亙亘亞亚佇伫佈布佔占併并來来侖仑侶侣侷局俁俣係系俔伣俠侠俥伡俬私倀伥倆俩倈俫倉仓個个們们倖幸倫伦倲㑈偉伟偑㐽側侧偵侦偽伪傌㐷傑杰傖伧傘伞備备傢家傭佣傯偬傳传傴伛債债傷伤傾倾僂偻僅仅僉佥僑侨僕仆僞伪僥侥僨偾僱雇價价儀仪儁俊儂侬億亿儈侩儉俭儎傤儐傧儔俦儕侪儘尽償偿優优儲储儷俪儸㑩儺傩儻傥儼俨兇凶兌兑兒儿兗兖內内兩两冊册冑胄冪幂凈净凍冻凜凛凱凯別别刪删剄刭則则剋克剎刹剗刬剛刚剝剥剮剐剴剀創创剷铲劃划劄札劇剧劉刘劊刽劌刿劍剑劏㓥劑剂劚㔉勁劲動动務务勛勋勝胜勞劳勢势勩勚勱劢勳勋勵励勸劝勻匀匭匦匯汇匱匮區区協协卹恤卻却卽即厙厍厠厕厤历厭厌厲厉厴厣參参叄叁叢丛吒咤吳吴吶呐呂吕咼呙員员唄呗唸念問问啓启啞哑啟启啢唡喎㖞喚唤喪丧喫吃喬乔單单喲哟嗆呛嗇啬嗊唝嗎吗嗚呜嗩唢嗶哔嘆叹嘍喽嘓啯嘔呕嘖啧嘗尝嘜唛嘩哗嘮唠嘯啸嘰叽嘵哓嘸呒嘽啴噁恶噓嘘噚㖊噝咝噠哒噥哝噦哕噯嗳噲哙噴喷噸吨噹当嚀咛嚇吓嚌哜嚐尝嚕噜嚙啮嚥咽嚦呖嚨咙嚮向嚲亸嚳喾嚴严嚶嘤囀啭囁嗫囂嚣囅冁囈呓囉啰囌苏囑嘱囪囱圇囵國国圍围園园圓圆圖图團团垻坝埡垭埰采執执堅坚堊垩堖垴堝埚堯尧報报場场塊块塋茔塏垲塒埘塗涂塚冢塢坞塤埙塵尘塹堑墊垫墜坠墮堕墰坛墳坟墶垯墻墙墾垦壇坛壋垱壎埙壓压壘垒壙圹壚垆壜坛壞坏壟垄壠垅壢坜壩坝壪塆壯壮壺壶壼壸壽寿夠够夢梦夥伙夾夹奐奂奧奥奩奁奪夺奬奖奮奋奼姹妝妆姍姗姦奸娛娱婁娄婦妇婭娅媧娲媯妫媰㛀媼媪媽妈嫋袅嫗妪嫵妩嫺娴嫻娴嫿婳嬀妫嬃媭嬈娆嬋婵嬌娇嬙嫱嬡嫒嬤嬷嬪嫔嬰婴嬸婶孃娘孋㛤孌娈孫孙學学孿孪宮宫寀采寢寝實实寧宁審审寫写寬宽寵宠寶宝將将專专尋寻對对導导尷尴屆届屍尸屓屃屜屉屢屡層层屨屦屬属岡冈峯峰峴岘島岛峽峡崍崃崑昆崗岗崙仑崢峥崬岽嵐岚嵗岁嵾㟥嶁嵝嶄崭嶇岖嶔嵚嶗崂嶠峤嶢峣嶧峄嶨峃嶮崄嶸嵘嶺岭嶼屿嶽岳巋岿巒峦巔巅巖岩巰巯巹卺帥帅師师帳帐帶带幀帧幃帏幓㡎幗帼幘帻幟帜幣币幫帮幬帱幷并幹干幾几庫库廁厕廂厢廄厩廈厦廎庼廕荫廚厨廝厮廟庙廠厂廡庑廢废廣广廩廪廬庐廳厅弒弑弔吊弳弪張张強强彆别彈弹彌弥彎弯彔录彙汇彠彟彥彦彫雕彲彨彿佛後后徑径從从徠徕復复徵征徹彻恆恒恥耻悅悦悞悮悵怅悶闷悽凄惡恶惱恼惲恽惻恻愛爱愜惬愨悫愴怆愷恺愾忾慄栗態态慍愠慘惨慚惭慟恸慣惯慤悫慪怄慫怂慮虑慳悭慶庆慺㥪慼戚慾欲憂忧憊惫憐怜憑凭憒愦憖慭憚惮憤愤憫悯憮怃憲宪憶忆懇恳應应懌怿懍懔懞蒙懟怼懣懑懤㤽懨恹懲惩懶懒懷怀懸悬懺忏懼惧懾慑戀恋戇戆戔戋戧戗戩戬戰战戱戯戲戏戶户扞捍拋抛拚拼挩捝挱挲挾挟捨舍捫扪捱挨捲卷掃扫掄抡掆㧏掗挜掙挣掛挂採采揀拣揚扬換换揮挥揯搄損损搖摇搗捣搧扇搵揾搶抢摑掴摜掼摟搂摯挚摳抠摶抟摺折摻掺撈捞撏挦撐撑撓挠撝㧑撟挢撣掸撥拨撫抚撲扑撳揿撻挞撾挝撿捡擁拥擄掳擇择擊击擋挡擓㧟擔担據据擠挤擡抬擣捣擬拟擯摈擰拧擱搁擲掷擴扩擷撷擺摆擻擞擼撸擽㧰擾扰攄摅攆撵攏拢攔拦攖撄攙搀攛撺攜携攝摄攢攒攣挛攤摊攪搅攬揽敎教敓敚敗败敘叙敵敌數数斂敛斃毙斆敩斕斓斬斩斷断於于旂旗旣既昇升時时晉晋晝昼暈晕暉晖暘旸暢畅暫暂曄晔曆历曇昙曉晓曏向曖暧曠旷曨昽曬晒書书會会朧胧朮术東东枴拐柵栅柺拐査查桿杆梔栀梘枧條条梟枭梲棁棄弃棊棋棖枨棗枣棟栋棡㭎棧栈棲栖棶梾椏桠椲㭏楊杨楓枫楨桢業业極极榘矩榦干榪杩榮荣榲榅榿桤構构槍枪槓杠槤梿槧椠槨椁槮椮槳桨槶椢槼椝樁桩樂乐樅枞樑梁樓楼標标樞枢樢㭤樣样樧榝樫㭴樳桪樸朴樹树樺桦樿椫橈桡橋桥機机橢椭橫横檁檩檉柽檔档檜桧檟槚檢检檣樯檮梼檯台檳槟檸柠檻槛櫃柜櫓橹櫚榈櫛栉櫝椟櫞橼櫟栎櫥橱櫧槠櫨栌櫪枥櫫橥櫬榇櫱蘖櫳栊櫸榉櫻樱欄栏欅榉權权欏椤欒栾欖榄欞棂欽钦歎叹歐欧歟欤歡欢歲岁歷历歸归歿殁殘残殞殒殤殇殨㱮殫殚殭僵殮殓殯殡殰㱩殲歼殺杀殻壳殼壳毀毁毆殴毿毵氂牦氈毡氌氇氣气氫氢氬氩氳氲氾泛汎泛汙污決决沒没沖冲況况泝溯洩泄洶汹浹浃涇泾涗涚涼凉淒凄淚泪淥渌淨净淩凌淪沦淵渊淶涞淺浅渙涣減减渢沨渦涡測测渾浑湊凑湞浈湧涌湯汤溈沩準准溝沟溫温溮浉溳涢溼湿滄沧滅灭滌涤滎荥滙汇滬沪滯滞滲渗滷卤滸浒滻浐滾滚滿满漁渔漊溇漚沤漢汉漣涟漬渍漲涨漵溆漸渐漿浆潁颍潑泼潔洁潙沩潚㴋潛潜潤润潯浔潰溃潷滗潿涠澀涩澆浇澇涝澐沄澗涧澠渑澤泽澦滪澩泶澮浍澱淀澾㳠濁浊濃浓濄㳡濕湿濘泞濚溁濛蒙濜浕濟济濤涛濧㳔濫滥濰潍濱滨濺溅濼泺濾滤瀂澛瀅滢瀆渎瀇㲿瀉泻瀋沈瀏浏瀕濒瀘泸瀝沥瀟潇瀠潆瀦潴瀧泷瀨濑瀰弥瀲潋瀾澜灃沣灄滠灑洒灕漓灘滩灝灏灡㳕灣湾灤滦灧滟灩滟災灾為为烏乌烴烃無无煉炼煒炜煙烟煢茕煥焕煩烦煬炀煱㶽熅煴熒荧熗炝熱热熲颎熾炽燁烨燈灯燉炖燒烧燙烫燜焖營营燦灿燬毁燭烛燴烩燶㶶燻熏燼烬燾焘爍烁爐炉爛烂爭争爲为爺爷爾尔牀床牆墙牘牍牴抵牽牵犖荦犛牦犢犊犧牺狀状狹狭狽狈猙狰猶犹猻狲獁犸獃呆獄狱獅狮獎奖獨独獪狯獫猃獮狝獰狞獱㺍獲获獵猎獷犷獸兽獺獭獻献獼猕玀猡現现琱雕琺珐琿珲瑋玮瑒玚瑣琐瑤瑶瑩莹瑪玛瑲玱璉琏璡琎璣玑璦瑷璫珰璯㻅環环璵玙璸瑸璽玺璿璇瓊琼瓏珑瓔璎瓚瓒甌瓯甕瓮產产産产畝亩畢毕畫画異异畵画當当疇畴疊叠痙痉痠酸痾疴瘂痖瘋疯瘍疡瘓痪瘞瘗瘡疮瘧疟瘮瘆瘲疭瘺瘘瘻瘘療疗癆痨癇痫癉瘅癒愈癘疠癟瘪癡痴癢痒癤疖癥症癧疬癩癞癬癣癭瘿癮瘾癰痈癱瘫癲癫發发皁皂皚皑皰疱皸皲皺皱盃杯盜盗盞盏盡尽監监盤盘盧卢盪荡眞真眥眦眾众睏困睜睁睞睐瞘眍瞜䁖瞞瞒瞶瞆瞼睑矇蒙矓眬矚瞩矯矫硃朱硜硁硤硖硨砗硯砚碕埼碩硕碭砀碸砜確确碼码碽䂵磑硙磚砖磠硵磣碜磧碛磯矶磽硗磾䃅礄硚礎础礙碍礦矿礪砺礫砾礬矾礱砻祕秘祿禄禍祸禎祯禕祎禡祃禦御禪禅禮礼禰祢禱祷禿秃秈籼稅税稈秆稏䅉稜棱稟禀種种稱称穀谷穇䅟穌稣積积穎颖穠秾穡穑穢秽穩稳穫获穭穞窩窝窪洼窮穷窯窑窵窎窶窭窺窥竄窜竅窍竇窦竈灶竊窃竪竖競竞筆笔筍笋筧笕筴䇲箇个箋笺箏筝箚札節节範范築筑篋箧篔筼篠筿篤笃篩筛篳筚簀箦簍篓簑蓑簞箪簡简簣篑簫箫簹筜簽签簾帘籃篮籌筹籔䉤籙箓籛篯籜箨籟籁籠笼籤签籩笾籪簖籬篱籮箩籲吁粵粤糉粽糝糁糞粪糧粮糰团糲粝糴籴糶粜糹纟糾纠紀纪紂纣約约紅红紆纡紇纥紈纨紉纫紋纹納纳紐纽紓纾純纯紕纰紖纼紗纱紘纮紙纸級级紛纷紜纭紝纴紡纺紬䌷紮扎細细紱绂紲绁紳绅紵纻紹绍紺绀紼绋紿绐絀绌終终絃弦組组絅䌹絆绊絎绗結结絕绝絛绦絝绔絞绞絡络絢绚給给絨绒絰绖統统絲丝絳绛絶绝絹绢綁绑綃绡綆绠綈绨綉绣綌绤綏绥綐䌼綑捆經经綜综綞缍綠绿綢绸綣绻綫线綬绶維维綯绹綰绾綱纲網网綳绷綴缀綵彩綸纶綹绺綺绮綻绽綽绰綾绫綿绵緄绲緇缁緊紧緋绯緑绿緒绪緓绬緔绱緗缃緘缄緙缂線线緝缉緞缎締缔緡缗緣缘緦缌編编緩缓緬缅緯纬緱缑緲缈練练緶缏緹缇緻致緼缊縈萦縉缙縊缢縋缒縐绉縑缣縕缊縗缞縛缚縝缜縞缟縟缛縣县縧绦縫缝縭缡縮缩縱纵縲缧縳䌸縴纤縵缦縶絷縷缕縹缥總总績绩繃绷繅缫繆缪繒缯織织繕缮繚缭繞绕繡绣繢缋繩绳繪绘繫系繭茧繮缰繯缳繰缲繳缴繸䍁繹绎繼继繽缤繾缱繿䍀纇颣纈缬纊纩續续纍累纏缠纓缨纔才纖纤纘缵纜缆缽钵罃䓨罈坛罌罂罎坛罰罚罵骂罷罢羅罗羆罴羈羁羋芈羣群羥羟羨羡義义羶膻習习翫玩翬翚翹翘翽翙耬耧耮耢聖圣聞闻聯联聰聪聲声聳耸聵聩聶聂職职聹聍聽听聾聋肅肃脅胁脈脉脛胫脣唇脩修脫脱脹胀腎肾腖胨腡脶腦脑腫肿腳脚腸肠膃腽膕腘膚肤膞䏝膠胶膩腻膽胆膾脍膿脓臉脸臍脐臏膑臘腊臚胪臟脏臠脔臢臜臥卧臨临臺台與与興兴舉举舊旧舖铺舘馆艙舱艤舣艦舰艫舻艱艰艷艳芻刍苧苎茲兹荊荆莊庄莖茎莢荚莧苋華华菴庵菸烟萇苌萊莱萬万萴荝萵莴葉叶葒荭葤荮葦苇葯药葷荤蒐搜蒓莼蒔莳蒕蒀蒞莅蒼苍蓀荪蓆席蓋盖蓮莲蓯苁蓴莼蓽荜蔔卜蔘参蔞蒌蔣蒋蔥葱蔦茑蔭荫蕁荨蕆蒇蕎荞蕒荬蕓芸蕕莸蕘荛蕢蒉蕩荡蕪芜蕭萧蕷蓣薀蕰薈荟薊蓟薌芗薑姜薔蔷薘荙薟莶薦荐薩萨薳䓕薴苎薵䓓薹苔薺荠藍蓝藎荩藝艺藥药藪薮藭䓖藴蕴藶苈藹蔼藺蔺蘀萚蘄蕲蘆芦蘇苏蘊蕴蘋苹蘚藓蘞蔹蘢茏蘭兰蘺蓠蘿萝虆蔂處处虛虚虜虏號号虧亏虯虬蛺蛱蛻蜕蜆蚬蝕蚀蝟猬蝦虾蝨虱蝸蜗螄蛳螞蚂螢萤螮䗖螻蝼螿螀蟄蛰蟈蝈蟎螨蟣虮蟬蝉蟯蛲蟲虫蟶蛏蟻蚁蠁蚃蠅蝇蠆虿蠍蝎蠐蛴蠑蝾蠔蚝蠟蜡蠣蛎蠨蟏蠱蛊蠶蚕蠻蛮衆众衊蔑術术衕同衚胡衛卫衝冲袞衮袷夹裊袅裏里補补裝装裡里製制複复褌裈褘袆褲裤褳裢褸褛褻亵襇裥襉裥襏袯襖袄襝裣襠裆襤褴襪袜襬摆襯衬襲袭襴襕覈核見见覎觃規规覓觅視视覘觇覡觋覥觍覦觎親亲覬觊覯觏覲觐覷觑覺觉覽览覿觌觀观觴觞觶觯觸触訁讠訂订訃讣計计訊讯訌讧討讨訐讦訒讱訓训訕讪訖讫託托記记訛讹訝讶訟讼訢䜣訣诀訥讷訩讻訪访設设許许訴诉訶诃診诊註注証证詁诂詆诋詎讵詐诈詒诒詔诏評评詖诐詗诇詘诎詛诅詞词詠咏詡诩詢询詣诣試试詩诗詫诧詬诟詭诡詮诠詰诘話话該该詳详詵诜詼诙詿诖誄诔誅诛誆诓誇夸誌志認认誑诳誒诶誕诞誘诱誚诮語语誠诚誡诫誣诬誤误誥诰誦诵誨诲說说説说誰谁課课誶谇誹诽誼谊誾訚調调諂谄諄谆談谈諉诿請请諍诤諏诹諑诼諒谅論论諗谂諛谀諜谍諝谞諞谝諡谥諢诨諤谔諦谛諧谐諫谏諭谕諮咨諱讳諳谙諶谌諷讽諸诸諺谚諼谖諾诺謀谋謁谒謂谓謄誊謅诌謊谎謎谜謐谧謔谑謖谡謗谤謙谦謚谥講讲謝谢謠谣謡谣謨谟謫谪謬谬謭谫謳讴謹谨謾谩譁哗證证譎谲譏讥譖谮識识譙谯譚谭譜谱譟噪譫谵譭毁譯译議议譴谴護护譸诪譽誉譾谫讀读讅谉變变讋詟讌䜩讎雠讒谗讓让讕谰讖谶讚赞讜谠讞谳谿溪豈岂豎竖豐丰豔艳豬猪豶豮貍狸貓猫貙䝙貝贝貞贞貟贠負负財财貢贡貧贫貨货販贩貪贪貫贯責责貯贮貰贳貲赀貳贰貴贵貶贬買买貸贷貺贶費费貼贴貽贻貿贸賀贺賁贲賂赂賃赁賄贿賅赅資资賈贾賊贼賑赈賒赊賓宾賕赇賙赒賚赉賜赐賞赏賠赔賡赓賢贤賣卖賤贱賦赋賧赕質质賫赍賬账賭赌賰䞐賴赖賵赗賺赚賻赙購购賽赛賾赜贄贽贅赘贇赟贈赠贊赞贋赝贍赡贏赢贐赆贓赃贔赑贖赎贗赝贛赣贜赃赬赪趕赶趙赵趨趋趲趱跡迹踐践踰逾踴踊蹌跄蹕跸蹟迹蹠跖蹣蹒蹤踪蹺跷躂跶躉趸躊踌躋跻躍跃躎䟢躑踯躒跞躓踬躕蹰躚跹躡蹑躥蹿躦躜躪躏軀躯車车軋轧軌轨軍军軑轪軒轩軔轫軛轭軟软軤轷軫轸軲轱軸轴軹轵軺轺軻轲軼轶軾轼較较輅辂輇辁輈辀載载輊轾輒辄輓挽輔辅輕轻輛辆輜辎輝辉輞辋輟辍輥辊輦辇輩辈輪轮輬辌輯辑輳辏輸输輻辐輼辒輾辗輿舆轀辒轂毂轄辖轅辕轆辘轉转轍辙轎轿轔辚轟轰轡辔轢轹轤轳辦办辭辞辮辫辯辩農农迴回逕径這这連连週周進进遊游運运過过達达違违遙遥遜逊遞递遠远遡溯適适遲迟遶绕遷迁選选遺遗遼辽邁迈還还邇迩邊边邏逻邐逦郟郏郵邮鄆郓鄉乡鄒邹鄔邬鄖郧鄧邓鄭郑鄰邻鄲郸鄴邺鄶郐鄺邝酇酂酈郦醃腌醖酝醜丑醞酝醟蒏醣糖醫医醬酱醱酦釀酿釁衅釃酾釅酽釋释釐厘釒钅釓钆釔钇釕钌釗钊釘钉釙钋針针釣钓釤钐釦扣釧钏釩钒釵钗釷钍釹钕釺钎釾䥺鈀钯鈁钫鈃钘鈄钭鈅钥鈈钚鈉钠鈍钝鈎钩鈐钤鈑钣鈒钑鈔钞鈕钮鈞钧鈡钟鈣钙鈥钬鈦钛鈧钪鈮铌鈰铈鈳钶鈴铃鈷钴鈸钹鈹铍鈺钰鈽钸鈾铀鈿钿鉀钾鉅巨鉆钻鉈铊鉉铉鉋铇鉍铋鉑铂鉕钷鉗钳鉚铆鉛铅鉞钺鉢钵鉤钩鉦钲鉬钼鉭钽鉳锫鉶铏鉸铰鉺铒鉻铬鉿铪銀银銃铳銅铜銍铚銑铣銓铨銖铢銘铭銚铫銛铦銜衔銠铑銣铷銥铱銦铟銨铵銩铥銪铕銫铯銬铐銱铞銳锐銷销銹锈銻锑銼锉鋁铝鋃锒鋅锌鋇钡鋌铤鋏铗鋒锋鋙铻鋝锊鋟锓鋣铘鋤锄鋥锃鋦锔鋨锇鋩铓鋪铺鋭锐鋮铖鋯锆鋰锂鋱铽鋶锍鋸锯鋼钢錁锞錄录錆锖錇锫錈锩錏铔錐锥錒锕錕锟錘锤錙锱錚铮錛锛錟锬錠锭錡锜錢钱錦锦錨锚錩锠錫锡錮锢錯错録录錳锰錶表錸铼錼镎鍀锝鍁锨鍃锪鍅钫鍆钔鍇锴鍈锳鍊炼鍋锅鍍镀鍔锷鍘铡鍚钖鍛锻鍠锽鍤锸鍥锲鍩锘鍬锹鍰锾鍵键鍶锶鍺锗鍼针鍾钟鎂镁鎄锿鎇镅鎊镑鎌镰鎔镕鎖锁鎘镉鎚锤鎛镈鎡镃鎢钨鎣蓥鎦镏鎧铠鎩铩鎪锼鎬镐鎭镇鎮镇鎰镒鎲镋鎳镍鎵镓鎶鿔鎸镌鎿镎鏃镞鏇旋鏈链鏌镆鏍镙鏐镠鏑镝鏗铿鏘锵鏜镗鏝镘鏞镛鏟铲鏡镜鏢镖鏤镂鏨錾鏰镚鏵铧鏷镤鏹镪鏺䥽鏽锈鐃铙鐋铴鐐镣鐒铹鐓镦鐔镡鐘钟鐙镫鐝镢鐠镨鐥䦅鐦锎鐧锏鐨镄鐫镌鐮镰鐯䦃鐲镯鐳镭鐵铁鐶镮鐸铎鐺铛鐿镱鑄铸鑊镬鑌镔鑑鉴鑒鉴鑔镲鑕锧鑞镴鑠铄鑣镳鑥镥鑭镧鑰钥鑱镵鑲镶鑷镊鑹镩鑼锣鑽钻鑾銮鑿凿钁镢钂镋長长門门閂闩閃闪閆闫閈闬閉闭開开閌闶閎闳閏闰閑闲閒闲間间閔闵閘闸閡阂閣阁閤合閥阀閨闺閩闽閫阃閬阆閭闾閱阅閲阅閶阊閹阉閻阎閼阏閽阍閾阈閿阌闃阒闆板闇暗闈闱闊阔闋阕闌阑闍阇闐阗闒阘闓闿闔阖闕阙闖闯關关闞阚闠阓闡阐闢辟闤阛闥闼陘陉陝陕陞升陣阵陰阴陳陈陸陆陽阳隉陧隊队階阶隕陨際际隨随險险隯陦隱隐隴陇隸隶隻只雋隽雖虽雙双雛雏雜杂雞鸡離离難难雲云電电霑沾霢霡霧雾霽霁靂雳靄霭靆叇靈灵靉叆靚靓靜静靝靔靦腼靨靥鞏巩鞝绱鞦秋鞽鞒韁缰韃鞑韆千韉鞯韋韦韌韧韍韨韓韩韙韪韜韬韝鞲韞韫韻韵響响頁页頂顶頃顷項项順顺頇顸須须頊顼頌颂頎颀頏颃預预頑顽頒颁頓顿頗颇領领頜颌頡颉頤颐頦颏頭头頮颒頰颊頲颋頴颕頷颔頸颈頹颓頻频頽颓顆颗題题額额顎颚顏颜顒颙顓颛顔颜願愿顙颡顛颠類类顢颟顥颢顧顾顫颤顬颥顯显顰颦顱颅顳颞顴颧風风颭飐颮飑颯飒颱台颳刮颶飓颸飔颺飏颻飖颼飕飀飗飄飘飆飙飈飚飛飞飠饣飢饥飣饤飥饦飩饨飪饪飫饫飭饬飯饭飱飧飲饮飴饴飼饲飽饱飾饰飿饳餃饺餄饸餅饼餈糍餉饷養养餌饵餎饹餏饻餑饽餒馁餓饿餕馂餖饾餘余餚肴餛馄餜馃餞饯餡馅館馆餬糊餱糇餳饧餵喂餶馉餷馇餺馎餼饩餾馏餿馊饁馌饃馍饅馒饈馐饉馑饊馓饋馈饌馔饑饥饒饶饗飨饜餍饞馋饢馕馬马馭驭馮冯馱驮馳驰馴驯馹驲駁驳駐驻駑驽駒驹駔驵駕驾駘骀駙驸駛驶駝驼駟驷駡骂駢骈駭骇駰骃駱骆駸骎駿骏騁骋騂骍騅骓騌骔騍骒騎骑騏骐騖骛騙骗騤骙騧䯄騫骞騭骘騮骝騰腾騶驺騷骚騸骟騾骡驀蓦驁骜驂骖驃骠驄骢驅驱驊骅驌骕驍骁驏骣驕骄驗验驚惊驛驿驟骤驢驴驤骧驥骥驦骦驪骊驫骉骯肮髏髅髒脏體体髕髌髖髋髮发鬆松鬍胡鬚须鬢鬓鬥斗鬧闹鬨哄鬩阋鬮阄鬱郁鬹鬶魎魉魘魇魚鱼魛鱽魢鱾魨鲀魯鲁魴鲂魷鱿魺鲄鮁鲅鮃鲆鮊鲌鮋鲉鮍鲏鮎鲇鮐鲐鮑鲍鮒鲋鮓鲊鮚鲒鮜鲘鮝鲞鮞鲕鮣䲟鮦鲖鮪鲔鮫鲛鮭鲑鮮鲜鮳鲓鮶鲪鮺鲝鯀鲧鯁鲠鯇鲩鯉鲤鯊鲨鯒鲬鯔鲻鯕鲯鯖鲭鯗鲞鯛鲷鯝鲴鯡鲱鯢鲵鯤鲲鯧鲳鯨鲸鯪鲮鯫鲰鯰鲶鯴鲺鯷鳀鯽鲫鯿鳊鰁鳈鰂鲗鰃鳂鰆䲠鰈鲽鰉鳇鰌䲡鰍鳅鰏鲾鰐鳄鰒鳆鰓鳃鰛鳁鰜鳒鰟鳑鰠鳋鰣鲥鰥鳏鰧䲢鰨鳎鰩鳐鰭鳍鰮鳁鰱鲢鰲鳌鰳鳓鰵鳘鰷鲦鰹鲣鰺鲹鰻鳗鰼鳛鰾鳔鱂鳉鱅鳙鱈鳕鱉鳖鱒鳟鱔鳝鱖鳜鱗鳞鱘鲟鱝鲼鱟鲎鱠鲙鱣鳣鱤鳡鱧鳢鱨鲿鱭鲚鱯鳠鱷鳄鱸鲈鱺鲡鳥鸟鳧凫鳩鸠鳬凫鳲鸤鳳凤鳴鸣鳶鸢鳾䴓鴆鸩鴇鸨鴉鸦鴒鸰鴕鸵鴛鸳鴝鸲鴞鸮鴟鸱鴣鸪鴦鸯鴨鸭鴯鸸鴰鸹鴴鸻鴷䴕鴻鸿鴿鸽鵁䴔鵂鸺鵃鸼鵐鹀鵑鹃鵒鹆鵓鹁鵜鹈鵝鹅鵠鹄鵡鹉鵪鹌鵬鹏鵮鹐鵯鹎鵰雕鵲鹊鵷鹓鵾鹍鶄䴖鶇鸫鶉鹑鶊鹒鶓鹋鶖鹙鶘鹕鶚鹗鶡鹖鶥鹛鶩鹜鶪䴗鶬鸧鶯莺鶲鹟鶴鹤鶹鹠鶺鹡鶻鹘鶼鹣鶿鹚鷀鹚鷁鹢鷂鹞鷄鸡鷉䴘鷊鹝鷓鹧鷖鹥鷗鸥鷙鸷鷚鹨鷥鸶鷦鹪鷫鹔鷯鹩鷲鹫鷳鹇鷴鹇鷸鹬鷹鹰鷺鹭鷽鸴鸂㶉鸇鹯鸊䴙鸌鹱鸏鹲鸕鸬鸘鹴鸚鹦鸛鹳鸝鹂鸞鸾鹵卤鹹咸鹺鹾鹼碱鹽盐麗丽麥麦麩麸麪面麫面麯曲麴曲麵面麼幺麽幺黃黄黌黉點点黨党黲黪黴霉黶黡黷黩黽黾黿鼋鼂鼌鼉鼍鼕冬鼴鼹齊齐齋斋齎赍齏齑齒齿齔龀齕龁齗龂齙龅齜龇齟龃齠龆齡龄齣出齦龈齧啮齪龊齬龉齲龋齶腭齷龌龍龙龎厐龐庞龑䶮龔龚龕龛龜龟鿁䜤鿓鿒敍叙枱台潀潨粧妆糭粽蒍蔿衞卫衹只么幺痺痹睪睾簷檐著着";
const FOLD = new Map();
for (let i = 0; i + 1 < T2S.length; i += 2) FOLD.set(T2S[i], T2S[i + 1]);

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LETTER = /[\p{L}\p{M}]/u;
const DIGIT = /[0-9０-９]/;
const ZH_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const ZH_UNIT = { 十: 10, 百: 100, 千: 1000, 万: 10000, 萬: 10000, 亿: 100000000, 億: 100000000 };
const ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORDINAL = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90, hundredth: 100, thousandth: 1000 };
const SCALE = { hundred: 100, thousand: 1000, million: 1000000, billion: 1000000000 };
// Words that only say how a number is written ("15%" against "fifteen percent", "$5" against "five dollars").
const SILENT = new Set(["percent", "dollars", "dollar", "point"]);

// The raw pieces of a text: one per Chinese/Japanese/Korean character, one per word, one per number.
function pieces(text) {
	const out = [];
	let i = 0;
	const n = text.length;
	while (i < n) {
		const cp = text.codePointAt(i);
		const ch = String.fromCodePoint(cp);
		const len = ch.length;
		if (CJK.test(ch)) {
			out.push({ type: "cjk", text: ch, s: i, e: i + len });
			i += len;
		} else if (DIGIT.test(ch)) {
			let j = i;
			while (j < n && (DIGIT.test(text[j]) || ((text[j] === "," || text[j] === "." || text[j] === ":") && DIGIT.test(text[j + 1] || "") && j > i))) j++;
			let e = j;
			const suffix = /^(st|nd|rd|th)\b/i.exec(text.slice(j, j + 3));
			if (suffix) e = j + 2;
			out.push({ type: "num", text: text.slice(i, j).replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)), s: i, e });
			i = e;
		} else if (LETTER.test(ch)) {
			let j = i;
			while (j < n) {
				const c = String.fromCodePoint(text.codePointAt(j));
				if (CJK.test(c)) break;
				if (LETTER.test(c)) j += c.length;
				else if ((c === "'" || c === "’") && j + 1 < n && LETTER.test(String.fromCodePoint(text.codePointAt(j + 1))) && !CJK.test(String.fromCodePoint(text.codePointAt(j + 1)))) j += 1;
				else break;
			}
			out.push({ type: "word", text: text.slice(i, j), s: i, e: j });
			i = j;
		} else i += len;
	}
	return out;
}

// Two spellings of one word are one word: "summarise" and "summarize", "colour" and "color", "Mister" and "Mr".
const SAME = { mister: "mr", doctor: "dr", okay: "ok", cannot: "cant", gonna: "goingto", wanna: "wantto" };
function spelling(w) {
	if (w in SAME) return SAME[w];
	if (w.length >= 6) return w.replace(/is(e|ed|es|er|ers|ing|ation|ations)$/, "iz$1").replace(/our(s|ed|ing|ite|ites)?$/, "or$1");
	return w;
}
function zhNumber(run) {
	let hasUnit = false;
	for (const c of run) if (c in ZH_UNIT) hasUnit = true;
	if (!hasUnit) return [...run].map((c) => ZH_DIGIT[c]).join("");
	let total = 0;
	let section = 0;
	let num = 0;
	let seen = false;
	for (const c of run) {
		if (c in ZH_DIGIT) {
			num = ZH_DIGIT[c];
			seen = true;
		} else {
			const u = ZH_UNIT[c];
			if (u < 10000) {
				section += (seen ? num : 1) * u;
			} else {
				section += num;
				total = (total + (section || 1)) * u;
				section = 0;
			}
			num = 0;
			seen = false;
		}
	}
	return String(total + section + num);
}

// What two models are compared on: the same pieces with spelling differences taken out
// (capitals, Traditional or Simplified characters, "fifty" or "50", "九点" or "9点").
// Every unit keeps where it sits in the text it came from.
function units(text) {
	const raw = pieces(String(text || ""));
	const out = [];
	const numeric = (u) => u && /^[0-9]+$/.test(u.k);
	for (let i = 0; i < raw.length; i++) {
		const p = raw[i];
		if (p.type === "cjk") {
			if (p.text === "百" && raw[i + 1] && raw[i + 1].text === "分" && raw[i + 2] && raw[i + 2].text === "之" && raw[i + 2].s === raw[i + 1].e && raw[i + 1].s === p.e) {
				i += 2;
				continue;
			}
			if (p.text in ZH_DIGIT || p.text in ZH_UNIT) {
				let j = i;
				let run = "";
				while (j < raw.length && raw[j].type === "cjk" && (raw[j].text in ZH_DIGIT || raw[j].text in ZH_UNIT) && (j === i || raw[j].s === raw[j - 1].e)) run += raw[j++].text;
				const last = out[out.length - 1];
				// "800万": a written number carried on by a Chinese unit
				if (last && last.num && last.e === p.s && run[0] in ZH_UNIT && ZH_UNIT[run[0]] >= 10000 && run.length === 1) {
					last.k = String(Math.round(Number(last.raw) * ZH_UNIT[run[0]]));
					last.e = raw[j - 1].e;
				} else out.push({ k: zhNumber(run), s: p.s, e: raw[j - 1].e, num: true, raw: zhNumber(run) });
				i = j - 1;
				continue;
			}
			if ((p.text === "点" || p.text === "點") && numeric(out[out.length - 1]) && raw[i + 1] && (raw[i + 1].type === "num" || raw[i + 1].text in ZH_DIGIT)) continue;
			out.push({ k: FOLD.get(p.text) || p.text, s: p.s, e: p.e });
			continue;
		}
		if (p.type === "num") {
			const plain = p.text.replace(/,/g, "");
			const parts = plain.split(/[.:]/);
			for (const part of parts) out.push({ k: part.replace(/^0+(?=\d)/, ""), s: p.s, e: p.e, num: true, raw: plain });
			continue;
		}
		const w = spelling(p.text.toLowerCase().replace(/['’]/g, ""));
		if (w in ONES || w in TENS || w in ORDINAL || (w in SCALE && false)) {
			// a spoken number, possibly several words: "twenty five", "one hundred and five", "twelve thousand"
			let j = i;
			let total = 0;
			let cur = 0;
			let any = false;
			let end = p.e;
			while (j < raw.length && raw[j].type === "word") {
				if (j > i && /[^\s-]/.test(text.slice(raw[j - 1].e, raw[j].s))) break;
				const x = raw[j].text.toLowerCase();
				if (x in ONES) {
					const v = ONES[x];
					if (any && (v >= 10 ? cur % 100 !== 0 : cur % 10 !== 0 || (cur % 100 !== 0 && cur % 100 < 20))) break;
					cur += v;
				} else if (x in TENS) {
					if (any && cur % 100 !== 0) break;
					cur += TENS[x];
				} else if (x in ORDINAL) {
					const v = ORDINAL[x];
					if (any && (v >= 10 ? cur % 100 !== 0 : cur % 10 !== 0 || (cur % 100 !== 0 && cur % 100 < 20))) break;
					cur += v;
					any = true;
					end = raw[j].e;
					j++;
					break;
				} else if (x === "hundred" && any && cur > 0 && cur < 100) cur *= 100;
				else if ((x === "thousand" || x === "million" || x === "billion") && any && cur > 0) {
					total += cur * SCALE[x];
					cur = 0;
				} else if (x === "and" && any && raw[j + 1] && raw[j + 1].type === "word" && (raw[j + 1].text.toLowerCase() in ONES || raw[j + 1].text.toLowerCase() in TENS) && (cur % 100 === 0 || cur === 0)) {
					j++;
					continue;
				} else break;
				any = true;
				end = raw[j].e;
				j++;
			}
			out.push({ k: String(total + cur), s: p.s, e: end, num: true, raw: String(total + cur) });
			i = j - 1;
			continue;
		}
		if (SILENT.has(w) && numeric(out[out.length - 1])) continue;
		out.push({ k: w, s: p.s, e: p.e });
	}
	return out;
}

// The cheapest way to turn one list of keys into another: which units match, which differ.
// Returns pairs [i, j] of matching positions, in order.
function matches(a, b) {
	const n = a.length;
	const m = b.length;
	if (!n || !m) return [];
	const w = m + 1;
	const d = new Uint32Array((n + 1) * w);
	for (let j = 0; j <= m; j++) d[j] = j;
	for (let i = 1; i <= n; i++) {
		d[i * w] = i;
		for (let j = 1; j <= m; j++) {
			const sub = d[(i - 1) * w + j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
			const del = d[(i - 1) * w + j] + 1;
			const ins = d[i * w + j - 1] + 1;
			d[i * w + j] = Math.min(sub, del, ins);
		}
	}
	const out = [];
	let i = n;
	let j = m;
	while (i > 0 && j > 0) {
		const here = d[i * w + j];
		if (a[i - 1] === b[j - 1] && here === d[(i - 1) * w + j - 1]) {
			out.push([i - 1, j - 1]);
			i--;
			j--;
		} else if (here === d[(i - 1) * w + j - 1] + 1) {
			i--;
			j--;
		} else if (here === d[(i - 1) * w + j] + 1) i--;
		else j--;
	}
	out.reverse();
	out.distance = d[n * w + m];
	return out;
}

function distance(a, b) {
	if (!a.length || !b.length) return Math.max(a.length, b.length);
	return matches(a, b).distance;
}

// How alike two texts are, 0 to 1.
function alike(a, b) {
	const most = Math.max(a.length, b.length);
	return most ? 1 - distance(a, b) / most : 1;
}

const keysOf = (u) => u.map((x) => x.k);
const cjkShare = (text) => {
	let c = 0;
	let all = 0;
	for (const ch of String(text || "")) {
		if (CJK.test(ch)) c++;
		if (CJK.test(ch) || LETTER.test(ch)) all++;
	}
	return all ? c / all : 0;
};

/**
 * Settle one stretch of speech from what several models heard.
 *
 * heard: [{ id, text, trust, say }] in the order their wording is preferred (the first one that is kept
 * gives the wording, punctuation and capitals). say: how many votes this model has (1 unless given).
 * trust: higher wins when the votes are level.
 *
 * Returns { text, from: id, map, alts, agreed, votes }:
 *  map[i]  where character i of text sits in the chosen model's own text (for timing)
 *  alts    [[start, end, [other readings]]] for the places where no two models agreed
 *  agreed  true when every model heard the same thing
 */
function settle(heard, opts = {}) {
	const floor = opts.outlier == null ? 0.4 : opts.outlier;
	let c = heard.filter((h) => h && typeof h.text === "string").map((h) => ({ ...h, text: h.text.trim(), u: null }));
	for (const h of c) {
		h.u = units(h.text);
		h.keys = keysOf(h.u);
	}
	const spoke = c.filter((h) => h.keys.length);
	// Nothing heard by most of them: treat it as noise.
	if (!spoke.length || (c.length >= 2 && spoke.length * 2 < c.length) || (c.length >= 3 && spoke.length === 1)) {
		return { text: "", from: null, map: [], alts: [], agreed: spoke.length === 0, votes: c.length, dropped: spoke.map((h) => h.id) };
	}
	c = spoke;
	const dropped = [];
	// A model that heard something else entirely (wrong language, made-up words) is left out
	// when the others hold together.
	if (c.length >= 3) {
		const sim = c.map((a) => c.map((b) => (a === b ? 1 : alike(a.keys, b.keys))));
		const keep = c.filter((_, i) => c.some((__, j) => j !== i && sim[i][j] >= floor));
		const held = c.some((_, i) => c.some((__, j) => j > i && sim[i][j] >= 0.6));
		if (held && keep.length >= 2 && keep.length < c.length) {
			for (const h of c) if (!keep.includes(h)) dropped.push(h.id);
			c = keep;
		}
	}
	const lead = c[0];
	const others = c.slice(1);
	const n = lead.u.length;
	// For each other model: which of the lead's units it also has.
	const link = others.map((o) => {
		const to = new Int32Array(n).fill(-1);
		for (const [i, j] of matches(lead.keys, o.keys)) to[i] = j;
		return to;
	});
	const out = [];
	const map = [];
	const alts = [];
	let agreed = true;
	let size = 0;
	const push = (text, at) => {
		if (!text) return;
		for (let k = 0; k < text.length; k++) map.push(at);
		out.push(text);
		size += text.length;
	};
	const tail = () => (out.length ? out[out.length - 1].slice(-1) : "");
	const cjkLead = cjkShare(lead.text) > 0.5;
	// Keep one script: a reading borrowed from another model is written the way the lead writes.
	const simplified = cjkLead && [...lead.text].filter((ch) => FOLD.has(ch)).length * 20 < lead.text.length;
	const dress = (text) => (simplified ? [...text].map((ch) => FOLD.get(ch) || ch).join("") : text);
	const join = (a, b) => (a && b && !CJK.test(a.slice(-1)) && !CJK.test(b[0]) ? `${a} ${b}` : a + b);
	let i = 0; // next unit of the lead
	let pos = 0; // next character of the lead's text
	let waiting = null; // readings with extra words, to hang on the next settled word
	const prev = others.map(() => -1); // last unit matched so far in each other model
	for (;;) {
		// The next unit every model agrees on. Everything before it, in every model, is one open place.
		let j = i;
		while (j < n && !link.every((to) => to[j] >= 0)) j++;
		const mine = lead.u.slice(i, j);
		const theirs = others.map((o, x) => o.u.slice(prev[x] + 1, j < n ? link[x][j] : o.u.length));
		if (mine.length || theirs.some((t) => t.length)) {
			const start = mine.length ? mine[0].s : j < n ? lead.u[j].s : pos;
			const stop = mine.length ? mine[mine.length - 1].e : start;
			push(lead.text.slice(pos, start), pos);
			pos = Math.max(pos, start);
			const said = [{ who: lead, keys: mine.map((u) => u.k).join(" "), text: mine.length ? lead.text.slice(start, stop) : "" }];
			others.forEach((o, x) => {
				const t = theirs[x];
				said.push({ who: o, keys: t.map((u) => u.k).join(" "), text: t.length ? o.text.slice(t[0].s, t[t.length - 1].e) : "" });
			});
			const groups = new Map();
			for (const s of said) {
				if (!groups.has(s.keys)) groups.set(s.keys, []);
				groups.get(s.keys).push(s);
			}
			// A model's say can count for more than one (the judge's does); most say wins, then most trust.
			let best = null;
			let all = 0;
			for (const g of groups.values()) {
				const trust = Math.max(...g.map((s) => s.who.trust || 0));
				const say = g.reduce((a, s) => a + (s.who.say || 1), 0);
				all += say;
				if (!best || say > best.say || (say === best.say && trust > best.trust)) best = { g, trust, say };
			}
			const sure = best.say * 2 > all;
			let pick = best.g[0];
			// Two models hearing nothing where the lead heard a lot: keep the lead's words.
			if (sure && pick.keys === "" && mine.length > 3) pick = said[0];
			// Words only one model has, with no two agreeing: leave them out, and note them.
			if (!sure && !mine.length && said.length > 2) pick = said[0];
			agreed = false;
			const from = size;
			if (pick === said[0]) {
				push(lead.text.slice(start, stop), start);
			} else if (pick.text) {
				const text = dress(pick.text);
				if (!mine.length) {
					// extra words the lead missed
					if (j < n) push(join(text, lead.text.slice(start, start + 1)).slice(0, -1), start);
					else push(join(tail() || "", text).slice(tail() ? 1 : 0), start);
				} else push(text, start);
			} else if (!out.length || /\s$/.test(out[out.length - 1])) {
				// words taken out: don't leave a stray comma or two spaces behind
				const rest = /^[,，、]?\s?/.exec(lead.text.slice(stop));
				pos = stop + (rest ? rest[0].length : 0);
			}
			if (!sure) {
				const seen = new Set([pick.keys]);
				const options = [];
				for (const s of said) {
					if (seen.has(s.keys)) continue;
					seen.add(s.keys);
					if (s.text) options.push(dress(s.text));
				}
				if (options.length) {
					if (size > from) alts.push([from, size, options]);
					else waiting = options;
				}
			}
			pos = Math.max(pos, stop);
		}
		if (j >= n) break;
		const u = lead.u[j];
		push(lead.text.slice(pos, u.s), pos);
		const at = size;
		push(lead.text.slice(Math.max(pos, u.s), u.e), u.s);
		if (waiting) {
			const word = lead.text.slice(u.s, u.e);
			alts.push([at, size, waiting.map((o) => join(o, word))]);
			waiting = null;
		}
		pos = Math.max(pos, u.e);
		others.forEach((_, x) => {
			prev[x] = link[x][j];
		});
		i = j + 1;
	}
	push(lead.text.slice(pos), pos);
	return { text: out.join(""), from: lead.id, map, alts, agreed: agreed && !dropped.length, votes: c.length, dropped };
}


/* ---------- the sound ---------- */
function openWav(file) {
	const fd = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(fd).size;
		const head = Buffer.alloc(12);
		fs.readSync(fd, head, 0, 12, 0);
		if (head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE")
			throw new Error("not a WAV file");
		let pos = 12;
		let fmt = null;
		let data = null;
		const h = Buffer.alloc(8);
		while (pos + 8 <= size) {
			fs.readSync(fd, h, 0, 8, pos);
			const id = h.toString("latin1", 0, 4);
			const len = h.readUInt32LE(4);
			if (id === "fmt ") {
				const b = Buffer.alloc(16);
				fs.readSync(fd, b, 0, 16, pos + 8);
				fmt = { format: b.readUInt16LE(0), channels: b.readUInt16LE(2), rate: b.readUInt32LE(4), align: b.readUInt16LE(12), bits: b.readUInt16LE(14) };
			} else if (id === "data") {
				data = { start: pos + 8, bytes: Math.min(len, size - pos - 8) };
				break;
			}
			pos += 8 + len + (len & 1);
		}
		if (!fmt || !data) throw new Error("a WAV file without sound in it");
		if ((fmt.format !== 1 && fmt.format !== 0xfffe) || fmt.bits !== 16 || fmt.rate !== RATE || !fmt.channels)
			throw new Error(`expected 16-bit sound at 16 kHz, got ${fmt.bits}-bit at ${fmt.rate} Hz`);
		return { fd, start: data.start, align: fmt.align, frames: Math.floor(data.bytes / fmt.align), close: () => fs.closeSync(fd) };
	} catch (e) {
		fs.closeSync(fd);
		throw e;
	}
}
// Samples `from` to `from + count` as numbers between -1 and 1 (the first channel).
function readSound(w, from, count) {
	const n = Math.max(0, Math.min(count, w.frames - from));
	const buf = Buffer.alloc(n * w.align);
	let got = 0;
	while (got < buf.length) {
		const r = fs.readSync(w.fd, buf, got, buf.length - got, w.start + from * w.align + got);
		if (!r) break;
		got += r;
	}
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * w.align) / 32768;
	return out;
}

/* ---------- files a step leaves behind ---------- */
const readJson = (file, otherwise) => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return otherwise;
	}
};
function writeJson(file, value) {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
	fs.renameSync(tmp, file);
}
// One JSON value per line, added to as the step goes. A last line cut short by a crash is dropped.
function readLines(file) {
	let text = "";
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const out = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			break;
		}
	}
	return out;
}
function rewriteLines(file, list) {
	fs.writeFileSync(file, list.map((x) => `${JSON.stringify(x)}\n`).join(""), { mode: 0o600 });
}
const addLine = (file, value) => fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const round2 = (x) => Math.round(x * 100) / 100;

/* ---------- the models ---------- */
function recognizer(sx, home, key, ask) {
	const base = (o) => ({
		featConfig: { sampleRate: RATE, featureDim: 80 },
		modelConfig: { numThreads: threads(), provider: "cpu", debug: 0, ...o },
	});
	const at = (...p) => modelPath(home, key, ...p);
	if (key === "first")
		return new sx.OfflineRecognizer(base({ senseVoice: { model: at("model.int8.onnx"), language: "", useInverseTextNormalization: 1 }, tokens: at("tokens.txt") }));
	if (key === "latin")
		return new sx.OfflineRecognizer(
			base({ transducer: { encoder: at("encoder.int8.onnx"), decoder: at("decoder.int8.onnx"), joiner: at("joiner.int8.onnx") }, tokens: at("tokens.txt"), modelType: "nemo_transducer" }),
		);
	if (key === "cjk") return new sx.OfflineRecognizer(base({ paraformer: { model: at("model.int8.onnx") }, tokens: at("tokens.txt") }));
	if (key === "judge")
		return new sx.OfflineRecognizer(
			base({
				qwen3Asr: {
					convFrontend: at("conv_frontend.onnx"),
					encoder: at("encoder.int8.onnx"),
					decoder: at("decoder.int8.onnx"),
					tokenizer: at("tokenizer"),
					hotwords: hotwords(ask),
					maxNewTokens: 256,
				},
				tokens: "",
			}),
		);
	throw new Error(`no such model: ${key}`);
}
// Names and terms from the meeting, for the model that takes hints. Commas separate them.
function hotwords(ask) {
	const out = [];
	let size = 0;
	for (const t of (ask && ask.terms) || []) {
		const term = String(t || "").replace(/[,，\s]+/g, " ").trim();
		if (!term || term.length > 40 || out.includes(term)) continue;
		if (out.length >= 40 || size + term.length > 400) break;
		out.push(term);
		size += term.length;
	}
	return out.join(",");
}
function hear(rec, samples) {
	const stream = rec.createStream();
	stream.acceptWaveform({ samples, sampleRate: RATE });
	rec.decode(stream);
	const r = rec.getResult(stream) || {};
	const lang = /<\|([a-z]+)\|>/.exec(r.lang || "");
	return {
		text: String(r.text || "").trim(),
		lang: lang ? lang[1] : "",
		tok: Array.isArray(r.tokens) ? r.tokens : [],
		ts: Array.isArray(r.timestamps) ? r.timestamps.map(round2) : [],
	};
}

/* ---------- step 1: find the speech, and hear it once ---------- */
function stepFirst(dir, home) {
	const sx = engine(home);
	const w = openWav(path.join(dir, "sound.wav"));
	const file = path.join(dir, "first.jsonl");
	let done = readLines(file);
	if (done.some((x) => x.end)) return w.close();
	rewriteLines(file, done);
	// Carrying on after a stop: from the end of the last stretch that was heard.
	let from = done.length ? done[done.length - 1].e : 0;
	const vad = new sx.Vad(
		{ sileroVad: { model: modelPath(home, "vad"), threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 0.4, maxSpeechDuration: PIECE - 1, windowSize: 512 }, sampleRate: RATE, numThreads: 1, debug: 0 },
		60,
	);
	const rec = recognizer(sx, home, "first");
	const base = from;
	const take = () => {
		while (!vad.isEmpty()) {
			const seg = vad.front(false);
			vad.pop();
			const s = base + seg.start;
			const heard = hear(rec, seg.samples);
			addLine(file, { s, e: s + seg.samples.length, ...heard });
		}
	};
	const STEP = 512 * 256;
	let last = 0;
	while (from < w.frames) {
		const block = readSound(w, from, STEP);
		for (let i = 0; i + 512 <= block.length; i += 512) {
			vad.acceptWaveform(block.subarray(i, i + 512));
			if (!vad.isEmpty()) take();
		}
		from += block.length;
		if (Date.now() - last > 1000 || from >= w.frames) {
			say({ step: "first", done: from / RATE, of: w.frames / RATE });
			last = Date.now();
		}
	}
	vad.flush();
	take();
	addLine(file, { end: true, frames: w.frames });
	w.close();
}

/* ---------- between steps: pieces in one language ---------- */
const family = (lang) => (lang === "zh" || lang === "yue" ? "cjk" : lang === "ja" || lang === "ko" ? "other" : "latin");
// From the stretches of speech and what SenseVoice made of each: the pieces the other models hear.
function plan(first, ask) {
	const segs = first.filter((x) => !x.end);
	const hint = ((ask && ask.hints) || []).map((h) => String(h).toLowerCase().slice(0, 2)).filter(Boolean);
	// A short stretch says little about its language: it goes with its neighbours, or with the
	// language the meeting was said to be in.
	const lang = segs.map((x) => (x.lang && x.lang !== "nospeech" && (x.e - x.s) / RATE >= 2 && x.text ? x.lang : ""));
	for (let i = 0; i < segs.length; i++) {
		if (lang[i]) continue;
		const x = segs[i];
		const own = x.lang && x.lang !== "nospeech" && x.text ? x.lang : "";
		let near = "";
		if (i > 0 && lang[i - 1] && (x.s - segs[i - 1].e) / RATE <= 1.5) near = lang[i - 1];
		else {
			for (let j = i + 1; j < segs.length && j <= i + 3; j++) {
				if (!(lang[j] || "")) continue;
				if ((segs[j].s - x.e) / RATE <= 3) near = lang[j];
				break;
			}
		}
		// Its own answer stands when the writing bears it out (Chinese characters for Chinese).
		const looksCjk = cjkShare(x.text) > 0.5;
		if (own && looksCjk === (family(own) !== "latin") && (!near || family(near) !== family(own))) lang[i] = own;
		else lang[i] = near || (hint.length ? hint[0] : own) || "en";
	}
	const pieces = [];
	for (let i = 0; i < segs.length; i++) {
		const x = segs[i];
		const last = pieces[pieces.length - 1];
		if (last && family(last.lang) === family(lang[i]) && (x.s - last.e) / RATE <= 0.8 && (x.e - last.s) / RATE <= PIECE) {
			last.e = x.e;
			last.to = i + 1;
		} else pieces.push({ s: x.s, e: x.e, lang: lang[i], from: i, to: i + 1 });
	}
	return pieces;
}

/* ---------- step 2: a second model hears each piece ---------- */
function hearPieces(dir, home, name, key, wanted, ask) {
	const sx = engine(home);
	const w = openWav(path.join(dir, "sound.wav"));
	const pieces = readJson(path.join(dir, "pieces.json"), []);
	const file = path.join(dir, `${name}.jsonl`);
	const done = readLines(file);
	rewriteLines(file, done);
	const have = new Set(done.map((x) => x.i));
	const todo = [];
	for (let i = 0; i < pieces.length; i++) if (!have.has(i) && wanted(pieces[i], i)) todo.push(i);
	const total = todo.reduce((a, i) => a + (pieces[i].e - pieces[i].s) / RATE, 0);
	const recs = {};
	let heard = 0;
	let last = 0;
	for (const i of todo) {
		const p = pieces[i];
		const k = key(p);
		if (!recs[k]) recs[k] = recognizer(sx, home, k, ask);
		const r = hear(recs[k], readSound(w, p.s, p.e - p.s));
		addLine(file, { i, m: k, text: r.text, tok: r.tok, ts: r.ts });
		heard += (p.e - p.s) / RATE;
		if (Date.now() - last > 1000 || i === todo[todo.length - 1]) {
			say({ step: name, done: heard, of: total });
			last = Date.now();
		}
	}
	w.close();
}
const stepSecond = (dir, home) =>
	hearPieces(dir, home, "second", (p) => family(p.lang), (p) => family(p.lang) !== "other");
function stepJudge(dir, home) {
	const ask = readJson(path.join(dir, "ask.json"), {});
	const list = new Set(readJson(path.join(dir, "judge.json"), []));
	hearPieces(dir, home, "judge", () => "judge", (_, i) => list.has(i), ask);
}

/* ---------- step 4: whose voice ---------- */
function stepVoices(dir, home) {
	const sx = engine(home);
	const w = openWav(path.join(dir, "sound.wav"));
	const first = readLines(path.join(dir, "first.jsonl")).filter((x) => !x.end);
	const sd = new sx.OfflineSpeakerDiarization({
		segmentation: { pyannote: { model: modelPath(home, "turns", "model.int8.onnx") }, numThreads: threads() },
		embedding: { model: modelPath(home, "voice"), numThreads: threads() },
		clustering: { numClusters: -1, threshold: 0.75 },
		minDurationOn: 0.3,
		minDurationOff: 0.5,
	});
	// A long recording is done a block at a time, cut at the longest pause near where a block would end.
	const cuts = [0];
	const total = w.frames / RATE;
	if (total > BLOCK * 1.1) {
		const n = Math.ceil(total / BLOCK);
		for (let k = 1; k < n; k++) {
			const want = (total * k) / n;
			let best = want;
			let gap = 0;
			for (let i = 1; i < first.length; i++) {
				const a = first[i - 1].e / RATE;
				const b = first[i].s / RATE;
				if (b < want - 120 || a > want + 120) continue;
				if (b - a > gap) {
					gap = b - a;
					best = (a + b) / 2;
				}
			}
			cuts.push(best);
		}
	}
	cuts.push(total);
	const segs = [];
	let voices = 0;
	for (let k = 0; k + 1 < cuts.length; k++) {
		say({ step: "voices", done: cuts[k], of: total });
		const from = Math.round(cuts[k] * RATE);
		const found = sd.process(readSound(w, from, Math.round(cuts[k + 1] * RATE) - from));
		let most = -1;
		for (const s of found) {
			segs.push([round2(cuts[k] + s.start), round2(cuts[k] + s.end), voices + s.speaker]);
			most = Math.max(most, s.speaker);
		}
		voices += most + 1;
	}
	say({ step: "voices", done: total, of: total });
	writeJson(path.join(dir, "voices.json"), { segs, joins: cuts.slice(1, -1).map(round2) });
	w.close();
}

/* ---------- step 5: one text ---------- */
// When each character of a model's text was said, from the times it gives for its tokens.
function tokenTimes(text, tok, ts, base, start, end) {
	const t = new Float64Array(text.length).fill(Number.NaN);
	let pos = 0;
	let known = 0;
	for (let k = 0; k < tok.length && k < ts.length; k++) {
		const piece = String(tok[k]).replace(/^[\s▁]+/, "");
		if (!piece) continue;
		const at = text.indexOf(piece, pos);
		if (at < 0 || at - pos > 16) continue;
		t[at] = base + ts[k];
		pos = at + piece.length;
		known++;
	}
	// No times, or too few to go by: spread the text evenly over the piece.
	if (known < 2 || known * 6 < text.replace(/\s/g, "").length) {
		for (let i = 0; i < t.length; i++) t[i] = start + ((end - start) * i) / Math.max(1, t.length);
		return t;
	}
	let prevAt = -1;
	let prev = start;
	for (let i = 0; i <= t.length; i++) {
		const here = i === t.length ? end : t[i];
		if (Number.isNaN(here)) continue;
		const v = Math.max(prev, here);
		for (let j = prevAt + 1; j < i; j++) t[j] = prev + ((v - prev) * (j - prevAt)) / (i - prevAt);
		if (i < t.length) t[i] = v;
		prevAt = i;
		prev = v;
	}
	return t;
}
function voiceAt(segs, t, from) {
	let best = -1;
	let start = -1;
	let near = -1;
	let dist = 1.0;
	for (let i = from.i; i < segs.length; i++) {
		const [s, e, v] = segs[i];
		if (e < t - 30) {
			from.i = i;
			continue;
		}
		if (s > t + 1) break;
		if (t >= s && t < e) {
			if (s >= start) {
				start = s;
				best = v;
			}
		} else {
			const d = t < s ? s - t : t - e;
			if (d < dist) {
				dist = d;
				near = v;
			}
		}
	}
	return best >= 0 ? best : near;
}
const joinText = (a, b) => (!a ? b : !b ? a : CJK.test(a.slice(-1)) || CJK.test(b[0]) ? a + b : `${a} ${b}`);
const STOP = /[.?!。？！…]/;

// The pieces, each settled between the models that heard it, cut into lines by voice.
function assemble(job) {
	const { first, pieces, second, judge, voices } = job;
	const segs = first.filter((x) => !x.end);
	const by = (list) => new Map(list.map((x) => [x.i, x]));
	const two = by(second);
	const three = by(judge || []);
	const vsegs = ((voices && voices.segs) || []).slice().sort((a, b) => a[0] - b[0]);
	const cursor = { i: 0 };
	const lines = [];
	const stats = { pieces: pieces.length, agreed: 0, judged: 0, doubts: 0, dropped: 0 };
	for (let i = 0; i < pieces.length; i++) {
		const p = pieces[i];
		const start = p.s / RATE;
		const end = p.e / RATE;
		// SenseVoice heard the piece a stretch at a time: its text and times are those, end to end.
		let firstText = "";
		const firstTimes = [];
		for (let k = p.from; k < p.to; k++) {
			const x = segs[k];
			if (!x.text) continue;
			const joined = joinText(firstText, x.text);
			const lead = joined.length - x.text.length;
			const t = tokenTimes(x.text, x.tok || [], x.ts || [], x.s / RATE, x.s / RATE, x.e / RATE);
			while (firstTimes.length < lead) firstTimes.push(x.s / RATE);
			for (const v of t) firstTimes.push(v);
			firstText = joined;
		}
		const b = two.get(i);
		const c = three.get(i);
		const cjk = family(p.lang) !== "latin";
		const heard = [];
		const one = { id: "first", text: firstText, trust: cjk ? 2 : 1 };
		const other = b ? { id: b.m, text: b.text, trust: cjk ? 1 : 2 } : null;
		if (cjk) heard.push(one);
		if (other) heard.push(other);
		if (!cjk) heard.push(one);
		// Parakeet and SenseVoice are unrelated, so when they agree they outvote the judge. SenseVoice and
		// Paraformer come from one family and make the same slips, so there the judge's word counts double:
		// it prevails, and the place is marked as in doubt.
		if (c) heard.push({ id: "judge", text: c.text, trust: 3, say: cjk ? 2 : 1 });
		const r = settle(heard);
		if (c) stats.judged++;
		else if (r.agreed) stats.agreed++;
		stats.dropped += r.dropped.length;
		if (!r.text.trim()) continue;
		let times;
		if (r.from === "first") times = firstTimes;
		else if (b && r.from === b.m) times = tokenTimes(b.text, b.tok || [], b.ts || [], start, start, end);
		else times = tokenTimes(c ? c.text : r.text, [], [], start, start, end);
		const at = (k) => {
			const m = r.map[Math.min(k, r.map.length - 1)];
			const v = times[Math.min(m, times.length - 1)];
			return Number.isFinite(v) ? v : start;
		};
		// Words (or single Chinese characters), each with its time and voice.
		const text = r.text;
		const atoms = [];
		for (let k = 0; k < text.length; ) {
			let e = k;
			const ch = String.fromCodePoint(text.codePointAt(k));
			if (CJK.test(ch)) e = k + ch.length;
			else while (e < text.length && !/\s/.test(text[e]) && !CJK.test(String.fromCodePoint(text.codePointAt(e)))) e++;
			if (e === k) e = k + 1;
			// trailing punctuation and spaces belong to the word before them
			while (e < text.length && (/\s/.test(text[e]) || /[\p{P}\p{S}]/u.test(text[e])) && !/^\s*[“"‘([（「《]/.test(text.slice(e))) e++;
			atoms.push({ s: k, e, t: at(k), v: -1 });
			k = e;
		}
		if (vsegs.length) {
			for (const a of atoms) a.v = voiceAt(vsegs, a.t, cursor);
			for (let k = 0; k < atoms.length; k++) if (atoms[k].v < 0) atoms[k].v = k ? atoms[k - 1].v : (atoms.find((a) => a.v >= 0) || { v: -1 }).v;
			// A voice heard for only a word or two in the middle of someone's sentence is a slip.
			const runs = [];
			for (const a of atoms) {
				const last = runs[runs.length - 1];
				if (last && last.v === a.v) last.n++;
				else runs.push({ v: a.v, n: 1, k: atoms.indexOf(a) });
			}
			for (let x = 0; x < runs.length; x++) {
				const run = runs[x];
				const span = atoms[run.k + run.n - 1].t - atoms[run.k].t;
				if (runs.length > 1 && (run.n < 3 || span < 0.6) && run.n < atoms.length / 2) {
					const to = x > 0 ? runs[x - 1].v : runs[x + 1].v;
					for (let k = run.k; k < run.k + run.n; k++) atoms[k].v = to;
					run.v = to;
				}
			}
			// A change of voice belongs at the end of a sentence when one is close by.
			const ends = (j) => j >= 0 && j < atoms.length && STOP.test(text.slice(atoms[j].s, atoms[j].e));
			for (let k = 1; k < atoms.length; k++) {
				if (atoms[k].v === atoms[k - 1].v || ends(k - 1)) continue;
				const before = atoms[k - 1].v;
				const after = atoms[k].v;
				// (Chinese counts a character at a time, so a sentence is more of them.)
				for (let d = 1; d <= (cjk ? 16 : 8); d++) {
					// the sentence ended d words earlier: those words belong to the next voice
					const back = k - 1 - d;
					if (ends(back) && atoms[k].t - atoms[back + 1].t <= 3 && atoms.slice(back + 1, k).every((a) => a.v === before)) {
						for (let j = back + 1; j < k; j++) atoms[j].v = after;
						break;
					}
					// the sentence ends d words later: those words still belong to the voice before
					const on = k - 1 + d;
					if (ends(on) && atoms[on].t - atoms[k].t <= 3 && atoms.slice(k, on + 1).every((a) => a.v === after)) {
						for (let j = k; j <= on; j++) atoms[j].v = before;
						break;
					}
				}
			}
		}
		for (let k = 0; k < atoms.length; ) {
			let e = k;
			while (e + 1 < atoms.length && atoms[e + 1].v === atoms[k].v) e++;
			const from = atoms[k].s;
			const raw = text.slice(from, atoms[e].e);
			const cut = raw.length - raw.trimStart().length;
			const line = { t: Math.round(atoms[k].t * 10) / 10, text: raw.trim() };
			if (atoms[k].v >= 0) line.v = atoms[k].v;
			const alt = [];
			for (const [s, x, options] of r.alts) {
				const a = Math.max(0, s - from - cut);
				const z = Math.min(line.text.length, x - from - cut);
				if (z <= a || s < from || s >= atoms[e].e) continue;
				alt.push([a, z, options.slice(0, 3).map((o) => o.slice(0, 80))]);
			}
			if (alt.length) {
				line.alt = alt.slice(0, 12);
				stats.doubts += line.alt.length;
			}
			if (line.text) lines.push(line);
			k = e + 1;
		}
	}
	// Voices are numbered from 1 in the order they first speak.
	const number = new Map();
	for (const l of lines) {
		if (l.v === undefined) continue;
		if (!number.has(l.v)) number.set(l.v, number.size + 1);
		l.v = number.get(l.v);
	}
	return { lines, voices: number.size, joins: (voices && voices.joins) || [], stats };
}

/* ---------- the whole job ---------- */
function loadSpeeds(home) {
	return { ...SPEEDS, ...readJson(path.join(home, "speeds.json"), {}) };
}
function noteSpeed(home, key, speed) {
	if (!(speed > 0) || !Number.isFinite(speed)) return;
	const all = readJson(path.join(home, "speeds.json"), {});
	all[key] = Math.round((all[key] ? all[key] * 0.6 + speed * 0.4 : speed) * 100) / 100;
	try {
		writeJson(path.join(home, "speeds.json"), all);
	} catch {
		/* a guess is kept instead */
	}
}
// How long a recording of `seconds` is likely to take here, from the speeds measured so far.
function estimate(home, seconds, lang) {
	const v = loadSpeeds(home);
	const second = lang === "zh" ? v.cjk : lang === "en" ? v.latin : Math.min(v.cjk, v.latin);
	const speech = seconds * 0.8;
	return Math.round(seconds / v.first + speech / second + (speech * 0.9) / v.judge + seconds / v.voices + 20);
}
let child = null;
function runStep(name, dir, home, onLine) {
	return new Promise((resolve, reject) => {
		const env = { ...process.env };
		const lib = path.join(home, "engine", "node_modules", `sherpa-onnx-${platformKey()}`);
		if (process.platform === "darwin") env.DYLD_LIBRARY_PATH = [lib, env.DYLD_LIBRARY_PATH].filter(Boolean).join(":");
		if (process.platform === "linux") env.LD_LIBRARY_PATH = [lib, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
		child = spawn(process.execPath, [__filename, "step", name, dir, home], { env, stdio: ["ignore", "pipe", "pipe"] });
		let rest = "";
		let err = "";
		child.stdout.on("data", (d) => {
			rest += d;
			for (;;) {
				const nl = rest.indexOf("\n");
				if (nl < 0) break;
				const line = rest.slice(0, nl);
				rest = rest.slice(nl + 1);
				try {
					onLine(JSON.parse(line));
				} catch {
					/* the engine's own chatter */
				}
			}
		});
		child.stderr.on("data", (d) => {
			err = (err + d).slice(-2000);
		});
		child.on("error", reject);
		child.on("close", (code, signal) => {
			child = null;
			if (code === 0) resolve();
			else reject(new Error(`the ${name} step stopped (${signal || code}): ${err.trim().split("\n").slice(-3).join(" | ") || "no message"}`));
		});
	});
}
async function run(dir, home) {
	const ask = readJson(path.join(dir, "ask.json"), {});
	const w = openWav(path.join(dir, "sound.wav"));
	const total = w.frames / RATE;
	w.close();
	if (total < 0.5) throw new Error("there is no sound in this recording");
	const v = loadSpeeds(home);
	// What each step is expected to cost, in seconds, so progress means time and not steps.
	const cost = { first: total / v.first, second: (total * 0.8) / Math.min(v.cjk, v.latin), judge: (total * 0.7) / v.judge, voices: ask.voices === false ? 0 : total / v.voices };
	const spent = { first: 0, second: 0, judge: 0, voices: 0 };
	const report = (step, part) => {
		spent[step] = Math.max(spent[step], cost[step] * Math.min(1, part));
		const all = Object.values(cost).reduce((a, b) => a + b, 0) || 1;
		const done = Object.values(spent).reduce((a, b) => a + b, 0);
		say({ step, progress: Math.round((done / all) * 1000) / 1000, left: Math.round(all - done) });
	};
	const timed = async (step, key, seconds, fn) => {
		const t0 = Date.now();
		await fn();
		const took = (Date.now() - t0) / 1000;
		// Only a fair stretch of work says how fast this computer is.
		if (key && seconds > 60 && took > 5) noteSpeed(home, key, seconds / took);
		report(step, 1);
	};
	const follow = (step) => (m) => {
		if (m.step === step && m.of > 0) report(step, m.done / m.of);
	};
	report("first", 0);
	const fresh = !readLines(path.join(dir, "first.jsonl")).length;
	await timed("first", fresh ? "first" : "", total, () => runStep("first", dir, home, follow("first")));
	const first = readLines(path.join(dir, "first.jsonl"));
	const pieces = plan(first, ask);
	writeJson(path.join(dir, "pieces.json"), pieces);
	const seconds = (list) => list.reduce((a, p) => a + (p.e - p.s) / RATE, 0);
	const speech = seconds(pieces);
	if (pieces.length) {
		const mostly = seconds(pieces.filter((p) => family(p.lang) === "cjk")) > speech / 2 ? "cjk" : "latin";
		const one = pieces.every((p) => family(p.lang) === mostly) && !readLines(path.join(dir, "second.jsonl")).length;
		cost.second = speech / v[mostly];
		await timed("second", one ? mostly : "", speech, () => runStep("second", dir, home, follow("second")));
		// The third model hears every piece the first two didn't agree on to the word.
		const second = new Map(readLines(path.join(dir, "second.jsonl")).map((x) => [x.i, x]));
		const segs = first.filter((x) => !x.end);
		const need = [];
		for (let i = 0; i < pieces.length; i++) {
			const p = pieces[i];
			let said = "";
			for (let k = p.from; k < p.to; k++) said = joinText(said, segs[k].text || "");
			const b = second.get(i);
			const r = settle([{ id: "first", text: said, trust: 1 }, ...(b ? [{ id: b.m, text: b.text, trust: 2 }] : [])]);
			if (ask.quick !== true || !b || !r.agreed) need.push(i);
		}
		writeJson(path.join(dir, "judge.json"), need);
		const toJudge = seconds(need.map((i) => pieces[i]));
		cost.judge = toJudge / v.judge;
		const whole = !readLines(path.join(dir, "judge.jsonl")).length;
		if (need.length) await timed("judge", whole ? "judge" : "", toJudge, () => runStep("judge", dir, home, follow("judge")));
		else report("judge", 1);
	} else {
		cost.second = 0;
		cost.judge = 0;
	}
	let voices = null;
	if (ask.voices !== false && pieces.length) {
		try {
			if (!fs.existsSync(path.join(dir, "voices.json"))) await timed("voices", "voices", total, () => runStep("voices", dir, home, follow("voices")));
			voices = readJson(path.join(dir, "voices.json"), null);
		} catch (e) {
			// The words matter more than who said them: carry on without voices.
			say({ note: `voices: ${e.message}` });
		}
	}
	report("voices", 1);
	const result = assemble({ first, pieces, second: readLines(path.join(dir, "second.jsonl")), judge: readLines(path.join(dir, "judge.jsonl")), voices });
	result.duration = Math.round(total * 1000) / 1000;
	result.by = "this Mac";
	result.models = ["SenseVoice", ...new Set(pieces.map((p) => (family(p.lang) === "cjk" ? "Paraformer" : family(p.lang) === "latin" ? "Parakeet" : "")).filter(Boolean)), "Qwen3-ASR"];
	writeJson(path.join(dir, "result.json"), result);
	say({ done: true, lines: result.lines.length, voices: result.voices, ...result.stats });
}

/* ---------- is it all here, and does it work ---------- */
function missing(home) {
	const out = [];
	if (!process.env.AK_SPEECH_ENGINE) {
		if (!fs.existsSync(path.join(enginePath(home), "sherpa-onnx.js"))) out.push("engine");
		else if (!fs.existsSync(path.join(home, "engine", "node_modules", `sherpa-onnx-${platformKey()}`, "sherpa-onnx.node"))) out.push("engine");
	}
	for (const [key, m] of Object.entries(MODELS)) {
		const ok = m.file ? fs.existsSync(modelPath(home, key)) : (m.has || []).every((f) => fs.existsSync(modelPath(home, key, f)));
		if (!ok) out.push(key);
	}
	return out;
}
// One model at a time, on the short samples that come with SenseVoice.
function checkOne(home, key) {
	const sx = engine(home);
	const samples = ["en", "zh"].map((n) => sx.readWave(modelPath(home, "first", "test_wavs", `${n}.wav`)));
	for (const s of samples) if (s.sampleRate !== RATE) throw new Error("the sample isn't at 16 kHz");
	const seconds = samples.reduce((a, s) => a + s.samples.length / RATE, 0);
	if (key === "voices") {
		const sd = new sx.OfflineSpeakerDiarization({
			segmentation: { pyannote: { model: modelPath(home, "turns", "model.int8.onnx") }, numThreads: threads() },
			embedding: { model: modelPath(home, "voice"), numThreads: threads() },
			clustering: { numClusters: -1, threshold: 0.75 },
			minDurationOn: 0.3,
			minDurationOff: 0.5,
		});
		const both = new Float32Array(samples[0].samples.length + samples[1].samples.length);
		both.set(samples[0].samples, 0);
		both.set(samples[1].samples, samples[0].samples.length);
		sd.process(both.subarray(0, RATE * 2));
		const t0 = Date.now();
		const found = sd.process(both);
		if (!found.length) throw new Error("no voice was found in the samples");
		return { speed: seconds / Math.max(0.01, (Date.now() - t0) / 1000) };
	}
	const rec = recognizer(sx, home, key, {});
	hear(rec, samples[0].samples.subarray(0, RATE * 2)); // the first use of a model is slow; don't time it
	const t0 = Date.now();
	const texts = samples.map((s) => hear(rec, s.samples).text);
	const took = Math.max(0.01, (Date.now() - t0) / 1000);
	const en = /tribal|chief|boy|gold|pieces/i.test(texts[0]);
	const zh = /[时時]间|[时時]間|早上|下午/.test(texts[1]);
	if (key === "first" || key === "judge") {
		if (!en || !zh) throw new Error(`didn't hear the samples right: ${JSON.stringify(texts)}`);
	} else if (key === "latin" ? !en : !zh) throw new Error(`didn't hear the sample right: ${JSON.stringify(texts)}`);
	// The model that only knows one of the two languages is timed on that one.
	return { speed: key === "latin" || key === "cjk" ? (samples[key === "latin" ? 0 : 1].samples.length / RATE / took) * 2 : seconds / took, heard: texts };
}
async function check(home) {
	const gone = missing(home);
	if (gone.length) return { ok: false, missing: gone, error: `not here yet: ${gone.join(", ")}` };
	const speeds = {};
	for (const key of ["first", "latin", "cjk", "judge", "voices"]) {
		let got = null;
		try {
			await runStep(`check:${key}`, home, home, (m) => {
				if (m.checked === key) got = m;
			});
		} catch (e) {
			return { ok: false, failed: key, error: e.message };
		}
		if (!got) return { ok: false, failed: key, error: "no answer" };
		speeds[key] = Math.round(got.speed * 100) / 100;
	}
	// A few seconds of sample say roughly how fast this computer is; real recordings refine it.
	const had = readJson(path.join(home, "speeds.json"), null);
	if (!had) writeJson(path.join(home, "speeds.json"), speeds);
	return { ok: true, speeds: had || speeds, threads: threads() };
}

if (require.main === module) {
	const [cmd, a, b, c] = process.argv.slice(2);
	const stop = () => {
		if (child) child.kill("SIGKILL");
		process.exit(130);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	(async () => {
		if (cmd === "run") await run(a, b);
		else if (cmd === "check") {
			const r = await check(a);
			say(r);
			if (!r.ok) process.exitCode = 1;
		} else if (cmd === "step") {
			if (a === "first") stepFirst(b, c);
			else if (a === "second") stepSecond(b, c);
			else if (a === "judge") stepJudge(b, c);
			else if (a === "voices") stepVoices(b, c);
			else if (a.startsWith("check:")) say({ checked: a.slice(6), ...checkOne(c, a.slice(6)) });
			else throw new Error(`no such step: ${a}`);
		} else {
			process.stderr.write("usage: node speech.cjs run <job folder> <speech folder> | check <speech folder>\n");
			process.exitCode = 2;
		}
	})().catch((e) => {
		say({ error: e.message });
		process.stderr.write(`${e.stack || e.message}\n`);
		process.exit(1);
	});
}

module.exports = {
	ENGINE_VERSION,
	ENGINE,
	MODELS,
	SPEEDS,
	RATE,
	platformKey,
	enginePath,
	modelPath,
	missing,
	estimate,
	loadSpeeds,
	units,
	matches,
	distance,
	alike,
	settle,
	cjkShare,
	plan,
	assemble,
	tokenTimes,
	family,
	hotwords,
	openWav,
	readSound,
};
