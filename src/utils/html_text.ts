// src/utils/html_text.ts
// 纯 HTML 内容处理：实体解码、正文提取、落地页特征提取。
// 从 src/tools/inspect_link.ts 拆出 —— browser_inspector（浏览器采证）与 rag/ingest_cases
// （联网入库正文清洗）都要用，住在 tools/ 里曾迫使 rag 反向依赖工具层。
// 全部为纯函数，不联网，可直接用样本测试。

export interface FormInput {
  type?: string;
  name?: string;
  placeholder?: string;
}

export interface FormInfo {
  action?: string;
  method?: string;
  inputs: FormInput[];
}

export function attr(tag: string, name: string): string | undefined {
  // 三种形态分开认：双/单引号值允许含空格（placeholder="请输入 短信验证码"），无引号值到空白或 > 为止。
  // 一把 `[^"'\s>]+` 会在引号内的空格处截断，placeholder 里的关键词就丢了。
  // 空值（name=""）与旧实现一致按"没有该属性"处理。
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === "" ? undefined : value;
}

/**
 * 解析页面里的相对/绝对 URL，失败返回 undefined。
 * 页面 HTML 是攻击者可控的：`action="http://"`、`content="0;url=//"` 这类畸形值会让
 * `new URL()` 抛 TypeError。抛出去等于让一条畸形属性废掉整次采证（连已经拿到的正文、
 * 表单、跳转链全丢），所以这里必须兜住——证据优先于严格解析。
 */
function resolveUrl(raw: string, base: URL): string | undefined {
  try {
    return new URL(raw, base).href;
  } catch {
    return undefined;
  }
}

/**
 * 内容整体丢弃的标签：里面的 "文本" 不是给人读的正文。
 * template 是未实例化的模板，noscript 在启用了 JS 的浏览器里本就不展示。
 */
const SKIPPED_TAGS = new Set(["script", "style", "template", "noscript", "svg", "head"]);

/**
 * 块级标签：转成换行而不是空格，否则 `a<div>b</div>` 会粘成 `ab`，
 * 行级标签（a/b/span…）则**不加空格**，否则 `a<b>bold</b>c` 会被拆成 `a bold c` 污染分词。
 * 这条对中文尤其要紧：中文没有词间空格，多插一个空格就可能让"验证码"变成"验证 码"。
 */
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot",
  "th", "thead", "tr", "ul",
]);

/** HTML 实体解码：关键词匹配的前提。不解码的话 `&#x9a8c;` 这类写法能直接绕过关键词表。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ",
  thinsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  middot: "·", times: "×", divide: "÷", laquo: "«", raquo: "»", ldquo: "“", rdquo: "”",
  lsquo: "‘", rsquo: "’", bull: "•", deg: "°", yen: "¥", euro: "€", pound: "£", sect: "§",
  para: "¶", dagger: "†", permil: "‰", prime: "′", Prime: "″", larr: "←", rarr: "→", harr: "↔",
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const digits = body.slice(hex ? 2 : 1);
      const code = Number.parseInt(digits, hex ? 16 : 10);
      // 必须显式判整数：parseInt 失败返回 NaN，而 `NaN <= 0` 是 false，
      // 只写范围判断会漏掉 NaN 并让 String.fromCodePoint 抛 RangeError。
      // 代理区（D800-DFFF）也跳过：它是 UTF-16 内部表示，不是可直接输出的字符。
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * HTML → 人读正文：单次扫描，跳过 SKIPPED_TAGS 的内容、把 BLOCK_TAGS 变成换行、
 * 其余标签直接剥掉（不加空格），最后解码实体。比"正则去标签"多做的三件事：
 * 不吃掉 script/style 里的伪标签、不破坏词边界、不把实体原样留在文本里。
 */
export function htmlToText(html: string): string {
  let out = "";
  let cursor = 0;

  while (cursor < html.length) {
    const open = html.indexOf("<", cursor);
    if (open === -1) {
      out += html.slice(cursor);
      break;
    }
    out += html.slice(cursor, open);

    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      cursor = end === -1 ? html.length : end + 3;
      continue;
    }

    const close = html.indexOf(">", open);
    if (close === -1) {
      // 落单的 "<"：当普通字符，不要吞掉后面所有内容
      out += "<";
      cursor = open + 1;
      continue;
    }

    const rawTag = html.slice(open + 1, close);
    const name = /^\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(rawTag)?.[1]?.toLowerCase() ?? "";

    if (name && SKIPPED_TAGS.has(name) && !rawTag.startsWith("/")) {
      // 跳到对应结束标签；找不到就当它一直延伸到文末
      const endTag = new RegExp(`</\\s*${name}\\b[^>]*>`, "i");
      const rest = html.slice(close + 1);
      const endMatch = endTag.exec(rest);
      cursor = endMatch ? close + 1 + endMatch.index + endMatch[0].length : html.length;
      continue;
    }

    if (name && BLOCK_TAGS.has(name)) out += "\n";
    cursor = close + 1;
  }

  return decodeHtmlEntities(out).replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

/** 纯函数：从 HTML 里提取落地页特征（不联网，测试直接喂样本） */
export function extractHtmlFeatures(html: string, baseUrl: string): {
  title: string;
  text: string;
  forms: FormInfo[];
  appLinks: string[];
  externalLinks: string[];
  iframeCount: number;
  metaRefresh?: string;
} {
  const title = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  // 返回解码后的标题：htmlToText 会跳过 <head>，title 不在正文里，实体编码的关键词只能在这里被解出
  const decodedTitle = decodeHtmlEntities(title).trim();

  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // 正文用扫描器提取：跳过 script/style/template、块级标签转换行、行级标签不插空格、实体解码
  const text = htmlToText(html);

  const base = new URL(baseUrl);
  const forms: FormInfo[] = [];
  for (const formMatch of body.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const inputs: FormInput[] = [];
    for (const inputTag of formMatch[2]!.matchAll(/<input\b([^>]*)>/gi)) {
      const tag = inputTag[1]!;
      const type = attr(tag, "type")?.toLowerCase() ?? "text"; // HTML 语义：无 type 默认为 text
      if (type === "hidden") continue;
      const name = attr(tag, "name");
      const placeholder = attr(tag, "placeholder");
      inputs.push({
        type,
        ...(name !== undefined ? { name } : {}),
        ...(placeholder !== undefined ? { placeholder } : {}),
      });
    }
    for (const selectTag of formMatch[2]!.matchAll(/<(select|textarea)\b([^>]*)>/gi)) {
      const name = attr(selectTag[2]!, "name");
      inputs.push({ type: selectTag[1]!.toLowerCase(), ...(name !== undefined ? { name } : {}) });
    }
    // 表单也可以由 <button> 提交（type 缺省即 submit），漏掉它就看不出"这个表单是让人点提交的"
    for (const buttonTag of formMatch[2]!.matchAll(/<button\b([^>]*)>/gi)) {
      const type = attr(buttonTag[1]!, "type")?.toLowerCase() ?? "submit";
      if (type !== "submit") continue;
      const label = attr(buttonTag[1]!, "name");
      inputs.push({ type: "submit", ...(label !== undefined ? { name: label } : {}) });
    }
    const rawAction = attr(formMatch[1]!, "action");
    const method = attr(formMatch[1]!, "method");
    // 解析不了就原样保留（"action 是畸形值"本身就是证据），但不允许它中断整次采证
    const action = rawAction === undefined ? undefined : resolveUrl(rawAction, base) ?? rawAction;
    forms.push({
      ...(action !== undefined ? { action } : {}),
      ...(method ? { method: method.toUpperCase() } : {}),
      inputs,
    });
  }

  const hrefs: string[] = [];
  for (const link of body.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#\s]+)["']/gi)) {
    try {
      hrefs.push(new URL(link[1]!, base).href);
    } catch {
      // 非法 href 跳过
    }
  }
  const appLinks = [...new Set(hrefs.filter((h) => /\.(apk|apks|ipa)([?#]|$)/i.test(h)))];
  const externalLinks = [...new Set(hrefs.filter((h) => {
    try {
      return new URL(h).hostname !== base.hostname;
    } catch {
      return false;
    }
  }))];

  const iframeCount = (body.match(/<iframe\b/gi) ?? []).length;
  // meta refresh 的两个属性顺序不保证（content 写在 http-equiv 前面同样合法），逐个 <meta> 标签解析
  let metaRefreshRaw: string | undefined;
  for (const metaTag of body.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = metaTag[0]!;
    if (attr(tag, "http-equiv")?.toLowerCase() !== "refresh") continue;
    const content = attr(tag, "content");
    const target = content === undefined ? undefined : /url\s*=\s*["']?([^"'>\s]+)/i.exec(content)?.[1];
    if (target !== undefined) {
      metaRefreshRaw = target;
      break;
    }
  }
  // 同上：目标解析不了也保留原文，"页面存在 meta refresh" 这条信号本身不能丢
  const metaRefresh = metaRefreshRaw === undefined ? undefined : resolveUrl(metaRefreshRaw, base) ?? metaRefreshRaw;

  return {
    title: decodedTitle,
    text,
    forms,
    appLinks,
    externalLinks,
    iframeCount,
    ...(metaRefresh !== undefined ? { metaRefresh } : {}),
  };
}
