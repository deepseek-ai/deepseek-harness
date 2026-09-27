Synthetic browser KeyboardEvents, not an OS input-method test.
package / isComposing=true: inspect=0, install=0; editable; value retained
- textbox "包名或地址":
  - /placeholder: 例如 dsh-plugin-whale-pet
  - text: ime-confirm-package
package / Safari isComposing=false, keyCode=229: inspect=0, install=0; editable; value retained
- textbox "包名或地址":
  - /placeholder: 例如 dsh-plugin-whale-pet
  - text: ime-confirm-package
package / compositionstart + unmarked Enter: inspect=0, install=0; editable; value retained
- textbox "包名或地址":
  - /placeholder: 例如 dsh-plugin-whale-pet
  - text: ime-confirm-package
package / compositionend + immediate unmarked Enter: inspect=0, install=0; editable; value retained
- textbox "包名或地址":
  - /placeholder: 例如 dsh-plugin-whale-pet
  - text: ime-confirm-package
package / compositionend + 9ms unmarked Enter: inspect=0, install=0; editable; value retained
- textbox "包名或地址":
  - /placeholder: 例如 dsh-plugin-whale-pet
  - text: ime-confirm-package
package / plain Enter: inspect=1, install=1
- dialog "插件安装失败":
  - button "返回编辑": 编辑
  - button "关闭"
  - alert: 插件安装失败
  - paragraph: "IME fixture: no package was installed"
  - paragraph: ime-confirm-package
  - paragraph: 版本 1.0.0
  - button "查看安装详情"
  - button "重试"
custom registry / isComposing=true: inspect=0, install=0; editable; value retained
- textbox "自定义地址":
  - /placeholder: https://npm.example.com/
  - text: https://registry.example.test/
custom registry / Safari isComposing=false, keyCode=229: inspect=0, install=0; editable; value retained
- textbox "自定义地址":
  - /placeholder: https://npm.example.com/
  - text: https://registry.example.test/
custom registry / compositionstart + unmarked Enter: inspect=0, install=0; editable; value retained
- textbox "自定义地址":
  - /placeholder: https://npm.example.com/
  - text: https://registry.example.test/
custom registry / compositionend + immediate unmarked Enter: inspect=0, install=0; editable; value retained
- textbox "自定义地址":
  - /placeholder: https://npm.example.com/
  - text: https://registry.example.test/
custom registry / compositionend + 9ms unmarked Enter: inspect=0, install=0; editable; value retained
- textbox "自定义地址":
  - /placeholder: https://npm.example.com/
  - text: https://registry.example.test/
custom registry / plain Enter: inspect=1, install=1
- dialog "插件安装失败":
  - button "返回编辑": 编辑
  - button "关闭"
  - alert: 插件安装失败
  - paragraph: "IME fixture: no package was installed"
  - paragraph: ime-confirm-registry
  - paragraph: 版本 1.0.0
  - button "查看安装详情"
  - button "重试"
Profile manifest unchanged; controlled Host result performed no package installation.
