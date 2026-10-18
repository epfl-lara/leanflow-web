export function Brand() {
  return (
    <div className="brand">
      <div className="brand-main">
        <img className="brand-mark" src="/leanflow-mark.svg" alt="" />
        <strong>LeanFlow Web</strong>
      </div>
      <div className="brand-links">
        <a
          className="brand-credit"
          href="https://epfl-lara.github.io/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Developed by EPFL LARA
        </a>
        <span aria-hidden="true">·</span>
        <a
          className="brand-credit"
          href="https://github.com/epfl-lara/leanflow-web"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="LeanFlow Web on GitHub (opens in a new tab)"
        >
          GitHub
        </a>
      </div>
    </div>
  )
}
