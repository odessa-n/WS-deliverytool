/** WebApp.gs **/

function doGet() {
  var output = HtmlService
    .createTemplateFromFile('Index')
    .evaluate()
    .setTitle(APP_CONFIG.APP_NAME);
  var mode = HtmlService.XFrameOptionsMode.DENY;
  if (mode != null) {
    output = output.setXFrameOptionsMode(mode);
  }
  return output;
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}