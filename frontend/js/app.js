// Entry point: header, language switch and routing between the views.
import { api } from './api.js';
import { setUiLanguage, t } from './i18n.js';
import { store, refreshState, setState, language } from './store.js';
import { renderHome } from './home.js';
import { renderCompany } from './company.js';
import { renderFactory, renderMonument } from './factory.js';
import { renderLaw } from './law.js';
import { renderCountry } from './country.js';
import { h, toast, errorText } from './ui.js';

const view = document.getElementById('view');
const routes = { home: renderHome, company: renderCompany, factory: renderFactory, monument: renderMonument,
  law: renderLaw, country: renderCountry };

function currentRoute() {
  const name = location.hash.replace(/^#\/?/, '');
  return routes[name] ? name : 'home';
}

function renderHeader() {
  const { state } = store;
  const route = currentRoute();
  document.getElementById('nav').replaceChildren(
    h('a', { href: '#/', class: route === 'home' ? 'active' : '' }, t('nav.home')),
    h('a', { href: '#/company', class: route === 'company' ? 'active' : '' }, t('nav.company')),
    h('a', { href: '#/factory', class: route === 'factory' ? 'active' : '' }, t('nav.factory')),
    h('a', { href: '#/monument', class: route === 'monument' ? 'active' : '' }, t('nav.monument')),
    h('a', { href: '#/law', class: route === 'law' ? 'active' : '' }, t('nav.law')),
    h('a', { href: '#/country', class: route === 'country' ? 'active' : '' }, t('nav.country')));
  document.getElementById('project-label').textContent =
    state.project ? t('header.project', { name: state.project.name }) : '';
  document.getElementById('version-label').textContent =
    state.version ? t('header.version', { version: state.version }) : '';
  const select = document.getElementById('language');
  select.replaceChildren(...state.languages.map((l) => h('option', { value: l.key }, l.name)));
  select.value = language();
  select.disabled = state.languages.length === 0;
}

async function render() {
  const route = currentRoute();
  renderHeader();
  view.className = `view view-${route}`;
  try {
    await routes[route](view);
  } catch (error) {
    console.error(error);
    view.replaceChildren(h('div', { class: 'notice error' }, errorText(error)));
  }
}

async function changeLanguage(event) {
  try {
    setState(await api.post('/api/settings', { language: event.target.value }));
    await setUiLanguage(language());
    await render();
  } catch (error) {
    toast(errorText(error), 'error');
  }
}

async function start() {
  store.onState = renderHeader;
  try {
    await setUiLanguage('english');
    await refreshState();
    await setUiLanguage(language());
  } catch (error) {
    view.replaceChildren(h('div', { class: 'notice error' }, errorText(error)));
    return;
  }
  document.getElementById('language').addEventListener('change', changeLanguage);
  window.addEventListener('hashchange', render);
  await render();
}

start();
