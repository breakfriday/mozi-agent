export type PageAccessCheck = {
  suspectedBlock: "login" | "verification" | null;
  evidence: ("visible_challenge" | "short_page_with_password" | "verification_text")[];
};

/** Heuristics only: the caller decides whether to wait for the user.
 * Serialized into the isolated page world; keep runtime dependencies inside this function.
 * Inspects the current document, without reading passwords or changing login state.
 */
export function checkPageAccess(): PageAccessCheck {
  const visible = (el: Element) =>
    el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const text = document.body?.innerText ?? "";
  const evidence: PageAccessCheck["evidence"] = [];
  const challenge = [...document.querySelectorAll(
    'iframe[src*="captcha"], iframe[src*="challenge"], #challenge-running, #b_captcha, input[name="captcha"]',
  )].some(visible);
  const login = text.length < 2000 &&
    [...document.querySelectorAll('input[type="password"]')].some(visible);
  const verificationText = /verify (?:that )?you are human|checking your browser|unusual traffic from your computer|完成验证|请输入验证码|验证您是人类/i.test(text.slice(0, 6000));
  if (challenge) evidence.push("visible_challenge");
  if (login) evidence.push("short_page_with_password");
  if (verificationText) evidence.push("verification_text");
  return { suspectedBlock: challenge || verificationText ? "verification" : login ? "login" : null, evidence };
}
