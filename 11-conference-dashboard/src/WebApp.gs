/** 웹앱 진입점. React 빌드 산출물(index.html)을 그대로 서빙합니다. */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('컨퍼런스 조회')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
