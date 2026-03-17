const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  entry: path.resolve(__dirname, 'src', 'renderer', 'index.tsx'),

  output: {
    path: path.resolve(__dirname, 'dist', 'renderer'),
    filename: 'bundle.js',
    clean: true,
  },

  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
    alias: {
      '@shared': path.resolve(__dirname, 'src', 'shared'),
      '@domain': path.resolve(__dirname, 'src', 'domain'),
      '@application': path.resolve(__dirname, 'src', 'application'),
      '@infrastructure': path.resolve(__dirname, 'src', 'infrastructure'),
      '@app': path.resolve(__dirname, 'src', 'app'),
    },
  },

  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: 'ts-loader',
          options: {
            // 使用主 tsconfig（含 jsx: react-jsx）
            configFile: path.resolve(__dirname, 'tsconfig.json'),
            // 只做转译，不做类型检查（加速构建）
            transpileOnly: true,
          },
        },
        exclude: /node_modules/,
      },
    ],
  },

  plugins: [
    new HtmlWebpackPlugin({
      template: path.resolve(__dirname, 'public', 'index.html'),
    }),
  ],

  target: 'electron-renderer',

  // 开发模式下使用 source-map 便于调试
  devtool: 'source-map',

  // 外部化 electron 和 node 原生模块
  externals: {
    electron: 'commonjs electron',
  },
};
