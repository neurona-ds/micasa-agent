const { getConfig } = require('./memory')

async function getMenu() {
  const menu = await getConfig('menu')
  if (!menu) {
    console.warn('No menu found in config table. Add a row with key "menu".')
    return '(Menú no disponible)'
  }
  return menu
}

module.exports = { getMenu }