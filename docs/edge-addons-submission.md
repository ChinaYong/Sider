# Edge Add-ons Privacy Form Reference

Applies to Sider 0.7.4. These statements reflect the current implementation and must be reviewed when functionality changes. PRIVACY.md is an unpublished draft until it has been committed and pushed.

## Single purpose

Help users combine selected web text, links, requested page content and prompt presets into questions on their chosen original AI websites, with user-initiated insertion, attachment and sending actions.

## Permission justification

Each suggested statement below is under 1000 characters.

| Field | Suggested text |
| --- | --- |
| `sidePanel` | Displays the chosen AI website, web references and prompt presets in Microsoft Edge's native sidebar, so users can include selected source material in their questions while browsing. |
| `storage` | Saves website configuration, prompt presets, font and launcher settings locally. Session storage temporarily holds selections, page snapshots and reference state to support worker recovery and source switching. |
| `activeTab` | Provides temporary access to the current tab after the user invokes the extension through its toolbar icon, keyboard shortcut or context menu, to read selected text or extract requested page content. |
| `tabs` | Reads titles and URLs of currently open tabs to display, search and switch reference sources, associate sidebars with tabs, return to source pages, and open or activate the chosen AI website. It does not query the browser's complete history database. |
| `scripting` | Injects scripts included in the extension package into authorized pages to capture selections and requested page content, display entry controls, and insert prompts, attach selected material or respond to user-initiated sending actions on AI websites. |
| `contextMenus` | Adds an Open Sider sidebar menu item to web pages, allowing users to open the sidebar from the current page and choose reference material. |
| `declarativeNetRequestWithHostAccess` | Uses session rules to remove Content-Security-Policy and X-Frame-Options response headers so the chosen AI website can load inside the sidebar. Rules are restricted to exact origins of registered, authorized AI websites, sub_frame requests, and contexts whose top-level domain is this extension. |
| Host permission justification | Access to https://chatgpt.com/* supports the default ChatGPT integration, sidebar connection, input and attachment operations. Optional HTTP/HTTPS access supports user-selected source pages and additional AI websites. Persistent access is requested by website origin for selections, requested page extraction, entry controls and original-site integration. |

## Remote code

Select **No, I am not using remote code**.

If a justification remains required:

> All JavaScript and dependencies used as extension logic are included in the package. The extension does not download or execute remote JavaScript or Wasm as extension logic. AI websites run their own website code in separate web pages; packaged adapter scripts interact with those pages.

## Data usage

Recommended disclosures for the current implementation include local processing and user-directed delivery to AI websites. The absence of a developer-operated collection server does not mean that the extension handles no user data.

| Category | Recommended selection | Scope |
| --- | --- | --- |
| Personally identifiable information | Select | Embedded ChatGPT compatibility uses account identifiers already supplied by that page. Their values remain in the website page. |
| Health information | Leave unchecked | No dedicated health-data extraction or analysis feature. |
| Financial and payment information | Leave unchecked | No payment or financial-record extraction or analysis feature. |
| Authentication information | Select | Embedded ChatGPT compatibility calls document.cookie and processes JavaScript-accessible cookies and site-provided account/session markers. This does not imply password collection or HttpOnly-cookie access. |
| Personal communications | Select | Users can reference AI conversation text, and the extension handles questions and chosen attachments. |
| Location | Leave unchecked | No location feature. AI websites handle their own network connections under their policies. |
| Web history | Select | Currently open tab titles/URLs and selected reference sources; not the complete browser history database. |
| User activity | Leave unchecked | No click, key, mouse or scroll tracking profiles. UI event handling and limited local startup diagnostics are described in the policy. |
| Website content | Select | Selected text, requested page content, prompts, conversation references and chosen attachments. |

The account/session classifications above are disclosure recommendations based on the existing compatibility code. Review each certification against actual behavior and the public policy. The current extension has no data-sale, advertising analytics or credit-scoring functionality.

## Privacy policy URL

The form's **0/2048** counter limits the URL field, not the length of the policy published at that URL. Enter a publicly accessible policy link, not the policy text.

The English [PRIVACY.md](../PRIVACY.md) draft is also under 2048 characters, including its title and line breaks. It must first be published to the public repository's main branch. Verify that this planned address works without signing in before submitting it:

[Planned policy address](https://github.com/ChinaYong/Sider/blob/main/PRIVACY.md)

Creating the local draft does not make that page available online. Publishing documentation alone does not require changing extension version 0.7.4.

## References

- [Microsoft Edge privacy form guidance](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension#step-6-enter-privacy-information)
- [Microsoft Edge developer policies](https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies)
- [Chromium user-data disclosure FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- Permissions and site scope: manifest.json.
- Embedding rules and tab metadata: src/background.js.
- ChatGPT account/session compatibility: src/chatgpt-session.js and src/embed-diagnostics.js.
- Local settings and temporary references: src/context-store.js, src/reference-sessions.js and src/configuration.js.
