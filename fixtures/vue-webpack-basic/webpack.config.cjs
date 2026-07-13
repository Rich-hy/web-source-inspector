const {
  WebSourceInspectorWebpackPlugin: WebSourceInspectorWebpackPlugin,
  createWebSourceInspectorBrowserMiddleware: createWebSourceInspectorBrowserMiddleware
} = require("web-source-inspector/webpack");

const path = require('node:path');
const { VueLoaderPlugin } = require('vue-loader');

module.exports = {
  mode: 'development',
  context: __dirname,
  entry: './src/main.js',
  output: {
    path: path.join(__dirname, 'dist'),
    filename: 'main.js',
    publicPath: '/',
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.vue$/u,
        use: [WebSourceInspectorWebpackPlugin.loaderPath, 'vue-loader'],
      },
    ],
  },
  plugins: [new VueLoaderPlugin(), new WebSourceInspectorWebpackPlugin()],
  devServer: {
    host: '127.0.0.1',
    port: 41732,

    static: {
      directory: path.join(__dirname, 'public'),
    },

    setupMiddlewares: function(middlewares, devServer) {
      const webSourceInspectorMiddleware = createWebSourceInspectorBrowserMiddleware(devServer.compiler);

      if (webSourceInspectorMiddleware) {
        middlewares.unshift({
          name: "web-source-inspector",
          middleware: webSourceInspectorMiddleware
        });
      }

      return middlewares;
    }
  },
};
