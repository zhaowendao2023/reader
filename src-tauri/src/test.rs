use std::fs;
use std::time::Instant;

fn main() -> std::io::Result<()> {
    // 记录开始时间
    let start = Instant::now();

    // 读取二进制数据
    let data = fs::read("F:\\comics\\[WaterRing] Chiori (Genshin Impact) [Decensored].cbz")?;

    // 计算耗时
    let duration = start.elapsed();
    println!("读取耗时: {:?}", duration);

    // 验证数据（可选）
    println!("文件大小: {} 字节", data.len());

    Ok(())
}
